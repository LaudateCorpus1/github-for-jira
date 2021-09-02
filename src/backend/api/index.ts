import express, { NextFunction, Request, Response } from "express";
import { check, oneOf, validationResult } from "express-validator";
import format from "date-fns/format";
import rateLimit from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import Redis from "ioredis";
import BodyParser from "body-parser";
import GitHubAPI from "../../config/github-api";
import { Installation, Subscription } from "../models";
import verifyInstallation from "../jira/verify-installation";
import logMiddleware from "../middleware/log-middleware";
import JiraClient from "../models/jira-client";
import uninstall from "../jira/uninstall";
import { serializeJiraInstallation, serializeSubscription } from "./serializers";
import getRedisInfo from "../../config/redis-info";
import { elapsedTimeMetrics } from "../../config/statsd";

const router = express.Router();
const bodyParser = BodyParser.urlencoded({ extended: false });

async function getInstallation(client, subscription) {
	const id = subscription.gitHubInstallationId;
	try {
		const response = await client.apps.getInstallation({ installation_id: id });
		response.data.syncStatus = subscription.syncStatus;
		return response.data;
	} catch (err) {
		return { error: err, id, deleted: err.status === 404 };
	}
}

function validAdminPermission(viewer) {
	return viewer.organization?.viewerCanAdminister || false;
}

/**
 * Finds the validation errors in this request and wraps them in an object with handy functions
 */
function returnOnValidationError(
	req: Request,
	res: Response,
	next: NextFunction
): void {
	const errors = validationResult(req);
	if (!errors.isEmpty()) {
		res.status(422).json({ errors: errors.array() });
	}
	next();
}

const viewerPermissionQuery = `{
  viewer {
    login
    organization(login: "fusion-arc") {
      viewerCanAdminister
    }
  }
}
`;

router.use(rateLimit({
	store: new RedisStore({
		client: new Redis(getRedisInfo("express-rate-limit").redisOptions)
	}),
	windowMs: 60 * 1000, // 1 minutes
	max: 60 // limit each IP to 60 requests per windowMs
}));

router.use(logMiddleware);

// All routes require a PAT to belong to someone on staff
// This middleware will take the token and make a request to GraphQL
// to see if it belongs to someone on staff

router.use(
	async (req: Request, res: Response, next: NextFunction): Promise<void> => {
		const token = req.get("Authorization");
		if (!token) {
			res.sendStatus(404);
			return;
		}
		try {
			// Create a separate octokit instance than the one used by the app
			const octokit = GitHubAPI({
				auth: token.split(" ")[1]
			});
			const { data, errors } = (
				await octokit.request({
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json"
					},
					method: "POST",
					// 'viewer' will be the person that owns the token
					query: viewerPermissionQuery,
					url: "/graphql"
				})
			).data;

			req.addLogFields({ login: data && data.viewer && data.viewer.login });

			if (errors) {
				res.status(401).json({ errors, viewerPermissionQuery });
				return;
			}

			if (!validAdminPermission(data.viewer)) {
				req.log.info(
					`User attempted to access staff routes: login=${data.viewer.login}, viewerCanAdminister=${data.viewer.organization?.viewerCanAdminister}`
				);
				res.status(401).json({
					error: "Unauthorized",
					message: "Token provided does not have required access"
				});
				return;
			}

			req.log.info(
				`Staff routes accessed: login=${data.viewer.login}, viewerCanAdminister=${data.viewer.organization?.viewerCanAdminister}`
			);

			next();
		} catch (err) {
			req.log.info({ err });

			if (err.status === 401) {
				res.status(401).send(err.HttpError);
				return;
			}
			res.sendStatus(500);
		}
	}
);

router.get(
	"/",
	elapsedTimeMetrics,
	(_: Request, res: Response): void => {
		res.send({});
	}
);

router.get(
	"/:installationId/repoSyncState.json",
	check("installationId").isInt(),
	returnOnValidationError,
	elapsedTimeMetrics,
	async (req: Request, res: Response): Promise<void> => {
		const githubInstallationId = Number(req.params.installationId);

		try {
			const subscription = await Subscription.getSingleInstallation(
				req.session.jiraHost,
				githubInstallationId
			);

			if (!subscription) {
				res.sendStatus(404);
				return;
			}

			const data = subscription.repoSyncState;
			res.json(data);
		} catch (err) {
			res.status(500).json(err);
		}
	}
);

router.post(
	"/:installationId/sync",
	bodyParser,
	check("installationId").isInt(),
	returnOnValidationError,
	elapsedTimeMetrics,
	async (req: Request, res: Response): Promise<void> => {
		const githubInstallationId = Number(req.params.installationId);
		req.log.info(req.body);
		const { jiraHost, resetType } = req.body;

		try {
			req.log.info(jiraHost, githubInstallationId);
			const subscription = await Subscription.getSingleInstallation(
				jiraHost,
				githubInstallationId
			);

			if (!subscription) {
				res.sendStatus(404);
				return;
			}

			await Subscription.findOrStartSync(subscription, resetType);

			res.status(202).json({
				message: `Successfully (re)started sync for ${githubInstallationId}`
			});
		} catch (err) {
			req.log.info(err);
			res.sendStatus(401);
		}
	}
);

// RESYNC ALL INSTANCES
router.post(
	"/resync",
	bodyParser,
	elapsedTimeMetrics,
	async (req: Request, res: Response): Promise<void> => {
		// Partial by default, can be made full
		const syncType = req.body.syncType || "partial";
		// Defaults to anything not completed
		const statusTypes = req.body.statusTypes as string[];
		// Defaults to any installation
		const installationIds = req.body.installationIds as number[];
		// Can be limited to a certain amount if needed to not overload system
		const limit = Number(req.body.limit) || undefined;
		// Needed for 'pagination'
		const offset = Number(req.body.offset) || 0;

		const subscriptions = await Subscription.getAllFiltered(installationIds, statusTypes, offset, limit);

		await Promise.all(subscriptions.map((subscription) =>
			Subscription.findOrStartSync(subscription, syncType)
		));

		res.json(subscriptions.map(serializeSubscription));
	}
);

router.get(
	"/jira/:clientKeyOrJiraHost",
	[
		bodyParser,
		oneOf([
			check("clientKeyOrJiraHost").isURL(),
			check("clientKeyOrJiraHost").isHexadecimal()
		]),
		returnOnValidationError,
		elapsedTimeMetrics
	],
	async (req: Request, res: Response): Promise<void> => {
		const where = req.params.clientKeyOrJiraHost.startsWith("http")
			? { jiraHost: req.params.clientKeyOrJiraHost }
			: { clientKey: req.params.clientKeyOrJiraHost };
		const jiraInstallations = await Installation.findAll({ where });
		if (!jiraInstallations.length) {
			res.sendStatus(404);
			return;
		}
		res.json(jiraInstallations.map((jiraInstallation) =>
			serializeJiraInstallation(jiraInstallation, req.log)
		));
	}
);

router.post(
	"/jira/:clientKey/uninstall",
	bodyParser,
	check("clientKey").isHexadecimal(),
	returnOnValidationError,
	elapsedTimeMetrics,
	async (request: Request, response: Response): Promise<void> => {
		response.locals.installation = await Installation.findOne({
			where: { clientKey: request.params.clientKey }
		});

		if (!response.locals.installation) {
			response.sendStatus(404);
			return;
		}
		const jiraClient = new JiraClient(
			response.locals.installation,
			request.log
		);
		const checkAuthorization = request.body.force !== "true";

		if (checkAuthorization && (await jiraClient.isAuthorized())) {
			response
				.status(400)
				.json({
					message: "Refusing to uninstall authorized Jira installation"
				});
			return;
		}
		request.log.info(
			`Forcing uninstall for ${response.locals.installation.clientKey}`
		);
		await uninstall(request, response);
	}
);

router.post(
	"/jira/:installationId/verify",
	bodyParser,
	check("installationId").isInt(),
	returnOnValidationError,
	elapsedTimeMetrics,
	async (req: Request, response: Response): Promise<void> => {
		const { installationId } = req.params;
		const installation = await Installation.findByPk(installationId);

		const respondWith = (message) =>
			response.json({
				message,
				installation: {
					enabled: installation.enabled,
					id: installation.id,
					jiraHost: installation.jiraHost
				}
			});

		if (installation.enabled) {
			respondWith("Installation already enabled");
			return;
		}
		await verifyInstallation(installation, req.log)();
		respondWith(
			installation.enabled ? "Verification successful" : "Verification failed"
		);
	}
);

router.get(
	"/:installationId",
	check("installationId").isInt(),
	returnOnValidationError,
	elapsedTimeMetrics,
	async (req: Request, res: Response): Promise<void> => {
		const { installationId } = req.params;
		const { client } = res.locals;

		try {
			const subscriptions = await Subscription.getAllForInstallation(
				Number(installationId)
			);

			if (!subscriptions.length) {
				res.sendStatus(404);
				return;
			}

			const { jiraHost } = subscriptions[0];
			const installations = await Promise.all(
				subscriptions.map((subscription) =>
					getInstallation(client, subscription)
				)
			);
			const connections = installations
				.filter((response) => !response.error)
				.map((data) => ({
					...data,
					isGlobalInstall: data.repository_selection === "all",
					updated_at: format(data.updated_at, "MMMM D, YYYY h:mm a"),
					syncState: data.syncState
				}));

			const failedConnections = installations.filter((response) => {
				req.log.error({...response}, "Failed installation");
				return response.error;
			});

			res.json({
				host: jiraHost,
				installationId,
				connections,
				failedConnections,
				hasConnections: connections.length > 0 || failedConnections.length > 0,
				repoSyncState: `${req.protocol}://${req.get(
					"host"
				)}/api/${installationId}/repoSyncState.json`
			});
		} catch (err) {
			req.log.error({installationId, err}, "Error getting installation");
			res.status(500).json(err);
		}
	}
);

export default router;

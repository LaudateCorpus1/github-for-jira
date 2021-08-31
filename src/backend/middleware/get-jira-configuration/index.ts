import format from "date-fns/format";
import moment from "moment";
import { Subscription } from "../../models";
import { NextFunction, Request, Response } from "express";
import statsd from "../../../config/statsd";
import { metricSyncStatus } from "../../../config/metric-names";
import { getLogger } from "../../../config/logger";
import * as Sentry from "@sentry/node";

const logger = getLogger("get.jira.configuration");

const syncStatus = (syncStatus) =>
	syncStatus === "ACTIVE" ? "IN PROGRESS" : syncStatus;

const sendFailedStatusMetrics = (installationId: string): void => {
	const syncError = "No updates in the last 15 minutes";
	logger.warn(syncError, `Sync failed: installationId=${installationId}`);

	Sentry.setExtra("Installation FAILED", syncError);
	Sentry.captureException(syncError);

	statsd.increment(metricSyncStatus.failed);
};

export async function getInstallation(client, subscription) {
	const id = subscription.gitHubInstallationId;
	try {
		const response = await client.apps.getInstallation({ installation_id: id });
		response.data.syncStatus = subscription.hasInProgressSyncFailed()
			? "FAILED"
			: syncStatus(subscription.syncStatus);
		response.data.syncWarning = subscription.syncWarning;
		response.data.subscriptionUpdatedAt = formatDate(subscription.updatedAt);
		response.data.totalNumberOfRepos = Object.keys(
			subscription.repoSyncState?.repos || {}
		).length;
		response.data.numberOfSyncedRepos =
			subscription.repoSyncState?.numberOfSyncedRepos || 0;
		response.data.jiraHost = subscription.jiraHost;

		response.data.syncStatus === "FAILED" && sendFailedStatusMetrics(id);

		return response.data;
	} catch (err) {
		return { error: err, id, deleted: err.code === 404 };
	}
}

const formatDate = function (date) {
	return {
		relative: moment(date).fromNow(),
		absolute: format(date, "MMMM D, YYYY h:mm a"),
	};
};

// An installation fails to connect when a user uninstalls the app in GitHub.
// We need to remove the subscription from the database.
const removeFailedConnections = (req: Request, installations: any, jiraHost: string) => {
	installations
		.filter((response) => !!response.error)
		.forEach(async (connection) => {
			try {
				const payload = {
					installationId: connection.id,
					host: jiraHost,
					clientKey: req.session.jwt,
				};

				await Subscription.uninstall(payload);
			} catch (err) {
				const deleteSubscriptionError = `Failed to delete subscription: ${err}`;
				logger.error(deleteSubscriptionError);
			}
		});
};

export default async (
	req: Request,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		const jiraHost = req.session.jiraHost;

		req.log.info(
			"Received jira configuration page request for Jira Host %s",
			jiraHost
		);

		const { client } = res.locals;
		const subscriptions = await Subscription.getAllForHost(jiraHost);
		const installations = await Promise.all(
			subscriptions.map((subscription) => getInstallation(client, subscription))
		);

		removeFailedConnections(req, installations, jiraHost);

		const connections = installations
			.filter((response) => !response.error)
			.map((data) => ({
				...data,
				isGlobalInstall: data.repository_selection === "all",
				installedAt: formatDate(data.updated_at),
				syncState: data.syncState,
				repoSyncState: data.repoSyncState,
			}));

		res.render("jira-configuration.hbs", {
			host: jiraHost,
			connections,
			hasConnections: connections.length > 0,
			APP_URL: process.env.APP_URL,
			csrfToken: req.csrfToken(),
			nonce: res.locals.nonce,
		});

		req.log.info("Jira configuration rendered successfully.");
	} catch (error) {
		return next(new Error(`Failed to render Jira configuration: ${error}`));
	}
};

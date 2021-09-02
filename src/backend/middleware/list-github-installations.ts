// TODO: are we using this?
import { NextFunction, Request, Response } from "express";
import { getLogger } from "../../config/logger";
import { pageRendered } from "../../config/metric-names";
import statsd from "../../config/statsd";


export default async (req: Request, res: Response, next: NextFunction): Promise<void> => {
	if (!req.session.githubToken) {
		return next(new Error("Unauthorized"));
	}

	req.log.info("Received list github installations request");

	const { github, client, isAdmin } = res.locals;

	try {
		const { data: { login } } = await github.users.getAuthenticated();
		const {
			data: { installations }
		} = await github.apps.listInstallationsForAuthenticatedUser();

		const adminInstallations = [];
		// TODO: make this parallel instead of sequential, then filter out
		for (const installation of installations) {
			// See if we can get the membership for this user
			if (
				await isAdmin({
					org: installation.account.login,
					username: login,
					type: installation.target_type
				})
			) {
				adminInstallations.push(installation);
			}
		}

		const { data: info } = await client.apps.getAuthenticated();

		const logger = getLogger("list-github-installations");

		logger.info("Rendering github-installations.hbs");
		statsd.increment(pageRendered.gitHubInstallations);

		return res.render("github-installations.hbs", {
			csrfToken: req.csrfToken(),
			nonce: res.locals.nonce,
			installations: adminInstallations,
			info
		});
	} catch (err) {
		req.log.error(err, "Unable list github installations page",);
		return next(err);
	}
};

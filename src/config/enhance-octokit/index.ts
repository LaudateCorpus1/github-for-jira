import statsd from "../statsd";
import { extractPath } from "../../backend/jira/client/axios";
import { GitHubAPI } from "probot";
import { metricHttpRequest } from "../metric-names";
import { getLogger } from "../logger";
import { Octokit } from "@octokit/rest";

const logger = getLogger("octokit");


const instrumentRequests = (octokit: GitHubAPI) => {
	octokit.hook.wrap("request", async (request, options) => {
		const requestStart = Date.now();
		let responseStatus = null;

		let response:Octokit.Response<any>;
		let error:any;
		try {
			response = await request(options);
			responseStatus = response.status;
			return response;
		} catch (err) {
			error = err;
			responseStatus = error?.responseCode;
			throw error;
		} finally {
			if(error || responseStatus < 200 || responseStatus >= 400) {
				logger.warn({request, response, error}, `Octokit error: failed request '${options.method} ${options.url}'`);
			}
			const elapsed = Date.now() - requestStart;
			const tags = {
				path: extractPath(options.url),
				method: options.method,
				status: responseStatus
			};

			statsd.histogram(metricHttpRequest().github, elapsed, tags);
		}
	});
};

/*
 * Customize an Octokit instance behavior.
 *
 * This acts like an Octokit plugin but works on Octokit instances.
 * (Because Probot instantiates the Octokit client for us, we can't use plugins.)
 */
export default (octokit: GitHubAPI): GitHubAPI => {
	instrumentRequests(octokit);
	return octokit;
};

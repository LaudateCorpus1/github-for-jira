import transformPullRequest from "../../transforms/pull-request";
import issueKeyParser from "jira-issue-key-parser";
import { isEmpty } from "../../../common/isEmpty";

import { Context } from "probot/lib/context";
import logger  from "../../../config/logger";

export default async (context: Context, jiraClient, util): Promise<void> => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let reviews: any = {};
	try {
		reviews = await context.github.pulls.listReviews({
			owner: context.payload.repository?.owner?.login,
			repo: context.payload.repository?.name,
			pull_number: context.payload.pull_request?.number
		});
	} catch (e) {
		context.log.warn(
			{
				error: e,
				payload: context.payload
			},
			"Can't retrieve reviewers."
		);
	}
	const author = await context.github.users.getByUsername({
		username: context.payload.pull_request.user.login
	});

	logger.info("AUTHOR: ", author)
	logger.info("CONTEXT: ", context)

	const jiraPayload = transformPullRequest(
		context.payload,
		context.payload.pull_request?.user,
		reviews.data
	);
	const { pull_request: pullRequest } = context.payload;

	if (!jiraPayload && context.payload?.changes?.title) {
		const issueKeys = issueKeyParser().parse(
			context.payload.changes?.title?.from
		);

		if (!isEmpty(issueKeys)) {
			return jiraClient.devinfo.pullRequest.delete(
				context.payload.repository?.id,
				pullRequest.number
			);
		}
	}

	const linkifiedBody = await util.unfurl(pullRequest.body);
	if (linkifiedBody) {
		const editedPullRequest = context.issue({
			body: linkifiedBody,
			id: pullRequest.id
		});
		await context.github.issues.update(editedPullRequest);
	}

	if (!jiraPayload) {
		context.log(
			{ noop: "no_jira_payload_pull_request" },
			"Halting futher execution for pull request since jiraPayload is empty"
		);
		return;
	}

	context.log(`Sending pullrequest update to Jira ${jiraClient.baseURL}`)
	await jiraClient.devinfo.repository.update(jiraPayload);
};

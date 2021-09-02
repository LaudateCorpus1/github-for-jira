/* eslint-disable @typescript-eslint/no-var-requires */
import transformPullRequest from ".";

describe("pull_request transform", () => {
	it("should not contain branches on the payload if pull request status is closed.", async () => {
		const pullRequestList = require("../../../../test/fixtures/api/transform-pull-request-list.json");

		const fixture = pullRequestList[0];
		fixture.title = "[TES-123] Branch payload Test";

		Date.now = jest.fn(() => 12345678);

		const data = transformPullRequest(fixture);

		const { updated_at, title } = fixture;

		expect(data).toMatchObject({
			id: 100403908,
			name: "integrations/test",
			pullRequests: [
				{
					author: {
						avatar: "https://avatars0.githubusercontent.com/u/173?v=4",
						name: "bkeepers",
						url: "https://api.github.com/users/bkeepers"
					},
					destinationBranch: "https://github.com/integrations/test/tree/devel",
					displayId: "#51",
					id: 51,
					issueKeys: ["TES-123"],
					lastUpdate: updated_at,
					sourceBranch: "use-the-force",
					sourceBranchUrl:
						"https://github.com/integrations/test/tree/use-the-force",
					status: "MERGED",
					timestamp: updated_at,
					title: title,
					url: "https://github.com/integrations/test/pull/51",
					updateSequenceId: 12345678
				}
			],
			url: "https://github.com/integrations/test",
			updateSequenceId: 12345678
		});
	});

	it("should contain branches on the payload if pull request status is different than closed.", async () => {
		const pullRequestList = JSON.parse(
			JSON.stringify(
				require("../../../../test/fixtures/api/transform-pull-request-list.json")
			)
		);

		const fixture = pullRequestList[1];
		fixture.title = "[TES-123] Branch payload Test";

		Date.now = jest.fn(() => 12345678);

		const data = transformPullRequest(fixture);

		const { updated_at, title } = fixture;

		expect(data).toMatchObject({
			id: 100403908,
			name: "integrations/test",
			pullRequests: [
				{
					author: {
						avatar: "https://avatars0.githubusercontent.com/u/173?v=4",
						name: "bkeepers",
						url: "https://api.github.com/users/bkeepers"
					},
					destinationBranch: "https://github.com/integrations/test/tree/devel",
					displayId: "#51",
					id: 51,
					issueKeys: ["TES-123"],
					lastUpdate: updated_at,
					sourceBranch: "use-the-force",
					sourceBranchUrl:
						"https://github.com/integrations/test/tree/use-the-force",
					status: "OPEN",
					timestamp: updated_at,
					title: title,
					url: "https://github.com/integrations/test/pull/51",
					updateSequenceId: 12345678
				}
			],
			branches: [
				{
					createPullRequestUrl:
						"https://github.com/integrations/test/pull/new/use-the-force",
					id: "use-the-force",
					issueKeys: ["TES-123"],
					lastCommit: {
						author: {
							name: "integrations"
						},
						authorTimestamp: "2018-05-04T14:06:56Z",
						displayId: "09ca66",
						fileCount: 0,
						hash: "09ca669e4b5ff78bfa6a9fee74c384812e1f96dd",
						id: "09ca669e4b5ff78bfa6a9fee74c384812e1f96dd",
						issueKeys: ["TES-123"],
						message: "n/a",
						updateSequenceId: 12345678,
						url: "https://github.com/integrations/test/commit/09ca669e4b5ff78bfa6a9fee74c384812e1f96dd"
					},
					name: "use-the-force",
					updateSequenceId: 12345678,
					url: "https://github.com/integrations/test/tree/use-the-force"
				}
			],
			url: "https://github.com/integrations/test",
			updateSequenceId: 12345678
		});
	});
});

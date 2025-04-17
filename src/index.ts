import * as http from 'http';
import { EventEmitter } from 'events';
import * as Koa from 'koa';
import * as Router from 'koa-router';
import * as bodyParser from 'koa-bodyparser';
import * as crypto from 'node:crypto';
import type { EventPayloadMap } from '@octokit/webhooks/dist-types/generated/webhook-identifiers';

const config = require('../config.json');

class WebhookEventEmitter extends EventEmitter {
	on<T extends keyof EventPayloadMap>(event: T, listener: (payload: EventPayloadMap[T]) => void): this
	on(event: string | symbol, listener: (...args: any[]) => void): this {
		return super.on(event, listener);
	}
}

const handler = new WebhookEventEmitter();

const post = async (text: string, home = true) => {
	const instance = config.instance.endsWith('/')
		? config.instance.substring(0, config.instance.length - 1)
		: config.instance;

	await fetch(`${instance}/api/notes/create`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			i: config.i,
			text,
			visibility: home ? 'home' : 'public',
			noExtractMentions: true,
			noExtractHashtags: true,
		}),
	})
};

const app = new Koa();
app.use(bodyParser());

const secret = config.hookSecret;

const router = new Router();

router.post('/github', ctx => {
	const body = JSON.stringify(ctx.request.body);
	const hash = crypto.createHmac('sha1', secret).update(body).digest('hex');
	const sig1 = Buffer.from(ctx.headers['x-hub-signature'] as string);
	const sig2 = Buffer.from(`sha1=${hash}`);

	// シグネチャ比較
	if (sig1.equals(sig2)) {
		let ghHeader = ctx.headers['x-github-event'] as string;
		handler.emit(ghHeader, ctx.request.body);
		ctx.status = 204;
	} else {
		ctx.status = 400;
	}
});

app.use(router.routes());

const server = http.createServer(app.callback());

server.listen(config.port);

handler.on('status', async event => {
	const state = event.state;
	switch (state) {
		case 'error':
		case 'failure':
			const commit = event.commit;
			const parent = commit.parents[0];

			// Fetch parent status
			await fetch(`${parent.url}/statuses`, {
				method: "GET",
				headers: {
					'User-Agent': 'misskey'
				},
			}).then(async res => {
				const parentStatuses = await res.json()
				const parentState = parentStatuses[0]?.state;
				const stillFailed = parentState === 'failure' || parentState === 'error';
				if (stillFailed) {
					await post(`⚠️ **BUILD STILL FAILED** ⚠️: ?[${commit.commit.message}](${commit.html_url})`);
				} else {
					await post(`🚨 **BUILD FAILED** 🚨: → ?[${commit.commit.message}](${commit.html_url}) ←`);
				}
			}).catch(err => {
				console.error(err);
			})

			break;
	}
});

handler.on('push', event => {
	const ref = event.ref;
	switch (ref) {
		case 'refs/heads/develop':
			const pusher = event.pusher;
			const compare = event.compare;
			const commits: any[] = event.commits;
			post([
				`🆕 Pushed by **${pusher.name}** with ?[${commits.length} commit${commits.length > 1 ? 's' : ''}](${compare}):`,
				commits.reverse().map(commit => `・[?[${commit.id.substr(0, 7)}](${commit.url})] ${commit.message.split('\n')[0]}`).join('\n'),
			].join('\n'));
			break;
	}
});

handler.on('issues', event => {
	const issue = event.issue;
	let title: string;
	switch (event.action) {
		case 'opened': title = `💥 Issue opened`; break;
		case 'closed': title = `💮 Issue closed`; break;
		case 'reopened': title = `🔥 Issue reopened`; break;
		default: return;
	}
	post(`${title}: #${issue.number} "${issue.title}"\n${issue.html_url}`);
});

handler.on('issue_comment', event => {
	const issue = event.issue;
	const comment = event.comment;
	let text: string;
	switch (event.action) {
		case 'created': text = `💬 Commented on "${issue.title}": ${event.sender.login} "<plain>${comment.body}</plain>"\n${comment.html_url}`; break;
		default: return;
	}
	post(text);
});

handler.on('release', event => {
	const release = event.release;
	let text: string;
	switch (event.action) {
		case 'published': text = `🎁 **NEW RELEASE**: [${release.tag_name}](${release.html_url}) is out. Enjoy!`; break;
		default: return;
	}
	post(text);
});

handler.on('watch', event => {
	const sender = event.sender;
	post(`$[spin ⭐️] Starred by ?[**${sender.login}**](${sender.html_url})`, false);
});

handler.on('fork', event => {
	const sender = event.sender;
	const repo = event.forkee;
	post(`$[spin.y 🍴] ?[Forked](${repo.html_url}) by ?[**${sender.login}**](${sender.html_url})`);
});

handler.on('pull_request', event => {
	const pr = event.pull_request;
	let text: string;
	switch (event.action) {
		case 'opened': text = `📦 New Pull Request: "${pr.title}"\n${pr.html_url}`; break;
		case 'reopened': text = `🗿 Pull Request Reopened: "${pr.title}"\n${pr.html_url}`; break;
		case 'closed':
			text = pr.merged
				? `💯 Pull Request Merged!: "${pr.title}"\n${pr.html_url}`
				: `🚫 Pull Request Closed: "${pr.title}"\n${pr.html_url}`;
			break;
		case 'ready_for_review': text = `👀 Pull Request marked as ready: "${pr.title}\n${pr.html_url}"`; break;
		default: return;
	}
	post(text);
});

handler.on('pull_request_review_comment', event => {
	const pr = event.pull_request;
	const comment = event.comment;
	let text: string;
	switch (event.action) {
		case 'created': text = `💬 Review commented on "${pr.title}": ${event.sender.login} "<plain>${comment.body}</plain>"\n${comment.html_url}`; break;
		default: return;
	}
	post(text);
});

handler.on('pull_request_review', event => {
	const pr = event.pull_request;
	const review = event.review;
	if (review.body === undefined || review.body === null || review.body.length <= 0) return;

	let text: string;
	switch (event.action) {
		case 'submitted': text = `👀 Review submitted: "${pr.title}": ${event.sender.login} "<plain>${review.body}</plain>"\n${review.html_url}`; break;
		default: return;
	}
	post(text);
});

handler.on('discussion', event => {
	const discussion = event.discussion;
	let title: string;
	let url: string;
	switch (event.action) {
		case 'created':
			title = `💭 Discussion opened`;
			url = discussion.html_url;
			break;
		case 'closed':
			title = `💮 Discussion closed`;
			url = discussion.html_url;
			break;
		case 'reopened':
			title = `🔥 Discussion reopened`;
			url = discussion.html_url;
			break;
		case 'answered':
			title = `✅ Discussion marked answer`;
			url = event.answer.html_url;
			break;
		case 'unanswered':
			title = `🔥 Discussion unmarked answer`;
			url = discussion.html_url;
			break;
		default: return;
	}
	post(`${title}: #${discussion.number} "${discussion.title}"\n${url}`);
});

handler.on('discussion_comment', event => {
	const discussion = event.discussion;
	const comment = event.comment;
	let text: string;
	switch (event.action) {
		case 'created': text = `💬 Commented on "${discussion.title}": ${event.sender.login} "<plain>${comment.body}</plain>"\n${comment.html_url}`; break;
		default: return;
	}
	post(text);
});

console.log("🚀 Ready! 🚀")

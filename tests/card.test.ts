import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCard, summarizeToolArgs, type CardView } from '../src/bridge/card.js';
import { collapseWhitespace } from '../src/util/text.js';

const options = { answerLimit: 100, showThinking: true, showTools: true };

function makeView(overrides: Partial<CardView> = {}): CardView {
	return {
		title: 'pi',
		status: 'working',
		answer: '',
		tools: [],
		notices: [],
		queued: [],
		footer: 'model: test',
		...overrides,
	};
}

interface CardShape {
	config: { wide_screen_mode: boolean; update_multi: boolean };
	header: { template: string; title: { content: string } };
	elements: Record<string, unknown>[];
}

async function render(view: CardView): Promise<CardShape> {
	return JSON.parse(JSON.stringify(buildCard(view, options))) as CardShape;
}

function markdownTexts(card: CardShape): string[] {
	return card.elements
		.filter((element) => element.tag === 'markdown')
		.map((element) => String(element.content ?? ''));
}

describe('buildCard', () => {
	it('renders a working card with a stop button', async () => {
		const card = await render(makeView({ abortValue: { cmd: 'abort', key: 'lark:chat' } }));
		assert.equal(card.header.template, 'blue');
		assert.match(card.header.title.content, /运行中/);
		const action = card.elements.find((element) => element.tag === 'action');
		assert.ok(action, 'expected an action element');
		const button = (action.actions as Record<string, unknown>[])[0];
		assert.deepEqual(button?.value, { cmd: 'abort', key: 'lark:chat' });
	});

	it('drops the stop button once the run is finished', async () => {
		const card = await render(makeView({ status: 'done', answer: 'ok', abortValue: { cmd: 'abort', key: 'k' } }));
		assert.equal(card.header.template, 'green');
		assert.equal(card.elements.some((element) => element.tag === 'action'), false);
	});

	it('maps every status to its own header colour', async () => {
		const templates = await Promise.all(
			(['working', 'done', 'aborted', 'error'] as const).map(async (status) => (await render(makeView({ status }))).header.template),
		);
		assert.deepEqual(templates, ['blue', 'green', 'orange', 'red']);
	});

	it('shows the thinking preview only while working', async () => {
		const working = markdownTexts(await render(makeView({ thinking: 'let me check the repo' }))).join('\n');
		assert.match(working, /思考中…/);
		assert.match(working, /let me check the repo/);
		const done = markdownTexts(await render(makeView({ status: 'done', thinking: 'let me check the repo' }))).join('\n');
		assert.doesNotMatch(done, /思考中/);
	});

	it('truncates a long working answer from the tail', async () => {
		const answer = 'x'.repeat(500);
		const card = await render(makeView({ answer }));
		const text = markdownTexts(card)[0] ?? '';
		assert.match(text, /仅显示最近 100 个字符/);
		assert.ok(text.length < 200, `expected a short preview, got ${text.length} chars`);
	});

	it('truncates a long finished answer and points at the follow-up message', async () => {
		const answer = 'line\n'.repeat(200);
		const card = await render(makeView({ status: 'done', answer }));
		const text = markdownTexts(card)[0] ?? '';
		assert.match(text, /完整内容见下方消息/);
		assert.ok(text.length < 200);
	});

	it('lists recent tool calls with status markers and durations', async () => {
		const card = await render(
			makeView({
				tools: [
					{ id: '1', name: 'bash', summary: 'npm test', status: 'done', durationMs: 1500 },
					{ id: '2', name: 'read', summary: 'src/a.ts', status: 'running' },
				],
			}),
		);
		const tools = markdownTexts(card).find((text) => text.includes('工具调用'));
		assert.ok(tools);
		assert.match(tools, /`bash` npm test \(1\.5s\)/);
		assert.match(tools, /`read` src\/a\.ts/);
	});

	it('hides tool activity when the option is off', async () => {
		const card = JSON.parse(
			JSON.stringify(
				buildCard(makeView({ tools: [{ id: '1', name: 'bash', summary: 'ls', status: 'done' }] }), {
					...options,
					showTools: false,
				}),
			),
		) as CardShape;
		assert.equal(markdownTexts(card).some((text) => text.includes('工具调用')), false);
	});

	it('caps notices and lists queued messages', async () => {
		const card = await render(
			makeView({
				notices: ['n1', 'n2', 'n3', 'n4', 'n5'],
				queued: ['first', 'second', 'third', 'fourth'],
			}),
		);
		const texts = markdownTexts(card);
		const noticeText = texts.find((text) => text.includes('- n1') || text.includes('- n2')) ?? '';
		assert.doesNotMatch(noticeText, /n1/);
		assert.match(noticeText, /n5/);
		const queued = texts.find((text) => text.includes('已排队')) ?? '';
		assert.match(queued, /first/);
		assert.match(queued, /其余 1 条/);
	});

	it('always includes the footer note', async () => {
		const card = await render(makeView({ answer: 'hello' }));
		const note = card.elements.at(-1);
		assert.equal(note?.tag, 'note');
	});

	it('uses placeholder text for an empty answer', async () => {
		assert.equal(markdownTexts(await render(makeView())).join(''), '_等待 Pi 输出…_');
		assert.match(markdownTexts(await render(makeView({ status: 'done' }))).join(''), /无文本输出/);
	});
});

describe('summarizeToolArgs', () => {
	it('prefers commands, then paths, then patterns', () => {
		assert.equal(summarizeToolArgs('bash', { command: 'ls  -la\n' }), 'ls -la');
		assert.equal(summarizeToolArgs('read', { file_path: 'src/index.ts' }), 'src/index.ts');
		assert.equal(summarizeToolArgs('grep', { pattern: 'TODO' }), 'TODO');
	});

	it('falls back to compact JSON and never exceeds the budget', () => {
		const summary = summarizeToolArgs('custom', { nested: { a: 1 }, list: ['x'] });
		assert.equal(summary, collapseWhitespace(JSON.stringify({ nested: { a: 1 }, list: ['x'] }), 80));
		const long = summarizeToolArgs('bash', { command: 'x'.repeat(200) });
		assert.equal(long.length, 80);
		assert.ok(long.endsWith('…'));
	});

	it('handles missing arguments', () => {
		assert.equal(summarizeToolArgs('bash', undefined), '');
		assert.equal(summarizeToolArgs('bash', 'plain'), 'plain');
	});
});

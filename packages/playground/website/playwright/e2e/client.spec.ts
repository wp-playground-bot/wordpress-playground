import { test, expect } from '../playground-fixtures.ts';

test('playground.cli() streams stdout', async ({ website }) => {
	await website.goto('./');
	await website.page.waitForFunction(() =>
		Boolean((window as any).playground)
	);

	// Step 1: writeFile
	await website.page.evaluate(async () => {
		await (window as any).playground.writeFile(
			'/tmp/script.php',
			"<?php echo 'hi!'; "
		);
	});

	// Step 2: cli() + stdoutText
	const output = await website.page.evaluate(async () => {
		const response = await (window as any).playground.cli([
			'php',
			'/tmp/script.php',
		]);
		return await response.stdoutText;
	});

	await expect(output).toContain('hi!');
});

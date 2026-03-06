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

	// Step 2: cli() — does it return at all?
	await website.page.evaluate(async () => {
		const response = await (window as any).playground.cli([
			'php',
			'/tmp/script.php',
		]);
		// Store on window so step 3 can access it
		(window as any).__cliResponse = response;
	});

	// Step 3: stdoutText
	const output = await website.page.evaluate(async () => {
		return await (window as any).__cliResponse.stdoutText;
	});

	await expect(output).toContain('hi!');
});

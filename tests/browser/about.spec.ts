import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const pkgVersion = JSON.parse(
  await readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
).version as string;

test('About page opens and shows heading, version badge, callout and repo link', async ({ page }) => {
  await page.goto('/');

  // Open the About page from the header info button.
  await page.getByRole('button', { name: 'Back', exact: true }).click();

  // Exactly one h1 named "Domus".
  const headings = page.getByRole('heading', { name: 'Domus', level: 1 });
  await expect(headings).toHaveCount(1);

  // Version badge reads "v" + package.json version.
  const badge = page.locator('.about-version-badge');
  await expect(badge).toHaveText(`v${pkgVersion}`);

  // Data-safety callout text is present.
  await expect(page.getByText(/Your rooms are saved in this browser on this device/)).toBeVisible();

  // GitHub link href is correct (now in the footer).
  const repoLink = page.getByRole('link', { name: 'github.com/8041q/Domus', exact: true });
  await expect(repoLink).toHaveAttribute('href', 'https://github.com/8041q/Domus');
  await expect(repoLink).toHaveAttribute('target', '_blank');
  await expect(repoLink).toHaveAttribute('rel', 'noopener noreferrer');

  // "Report an issue" link is present.
  await expect(page.getByRole('link', { name: 'Report an issue', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/8041q/Domus/issues',
  );

  // h2 sections are present: What you can do, Basic controls, Open source, Built with, Credits.
  await expect(page.getByRole('heading', { name: 'What you can do', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Basic controls', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open source', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Built with', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Credits', level: 2 })).toBeVisible();

  // No sidebar sections remain.
  await expect(page.getByRole('heading', { name: 'Repository', level: 2 })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Issues', level: 2 })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Interface font', level: 2 })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Logo', level: 2 })).not.toBeVisible();
});

test('About page fits without scrolling at 1280×720', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('heading', { name: 'Credits', level: 2 }).waitFor();

  const about = page.locator('.about-page');
  const { scrollHeight, clientHeight } = await about.evaluate((node) => ({
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  }));
  expect(scrollHeight).toBeLessThanOrEqual(clientHeight);
});

test('About page has no horizontal overflow at 390×700 and 1280×720', async ({ page }) => {
  for (const [w, h] of [[390, 700], [1280, 720]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('heading', { name: 'Credits', level: 2 }).waitFor();

    const about = page.locator('.about-page');
    const { scrollWidth, clientWidth } = await about.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  }
});

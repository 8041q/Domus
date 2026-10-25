import { test, expect } from '@playwright/test';

test('Walk settles to idle after movement and records frame work', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const profile = { recording: false, frames: [] as number[], draws: 0 };
    (window as unknown as { walkProfile: typeof profile }).walkProfile = profile;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => raf(time => {
      const start = performance.now();
      callback(time);
      if (profile.recording) profile.frames.push(performance.now() - start);
    });
    for (const Context of [WebGLRenderingContext, WebGL2RenderingContext]) {
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'] as const) {
        const prototype = Context.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
        const original = prototype[name];
        if (!original) continue;
        prototype[name] = function (...args) {
          if (profile.recording) profile.draws++;
          return original.apply(this, args);
        };
      }
    }
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Plan room', exact: true }).click();
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  const canvas = page.locator('.viewport canvas');
  await expect(canvas).toBeFocused();
  await page.keyboard.press('w', { delay: 200 });
  await page.waitForTimeout(500); // Allow the controller's bounded settling tail to finish.
  await page.evaluate(() => {
    const profile = (window as unknown as { walkProfile: { recording: boolean; frames: number[]; draws: number } }).walkProfile;
    profile.frames = []; profile.draws = 0; profile.recording = true;
  });
  await page.keyboard.down('w');
  await page.waitForTimeout(1200); // Sample sustained motion rather than a hardware-specific frame budget.
  await page.keyboard.up('w');
  const active = await page.evaluate(() => {
    const profile = (window as unknown as { walkProfile: { recording: boolean; frames: number[]; draws: number } }).walkProfile;
    profile.recording = false;
    return { frames: profile.frames.length, meanMs: profile.frames.reduce((sum, value) => sum + value, 0) / Math.max(1, profile.frames.length), draws: profile.draws };
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const profile = (window as unknown as { walkProfile: { recording: boolean; frames: number[]; draws: number } }).walkProfile;
    profile.frames = []; profile.draws = 0; profile.recording = true;
  });
  await page.waitForTimeout(300);
  const idle = await page.evaluate(() => {
    const profile = (window as unknown as { walkProfile: { recording: boolean; frames: number[]; draws: number } }).walkProfile;
    profile.recording = false;
    return { frames: profile.frames.length, draws: profile.draws };
  });
  console.log(JSON.stringify({ browser: testInfo.project.name, active, idle }));
  await testInfo.attach('walk-profile.json', { body: JSON.stringify({ active, idle }), contentType: 'application/json' });
  expect(active.frames).toBeGreaterThan(0);
  expect(idle).toEqual({ frames: 0, draws: 0 });
});

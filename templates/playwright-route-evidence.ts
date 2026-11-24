import { expect, type Page, type TestInfo } from '@playwright/test';

export async function captureRoute(page: Page, info: TestInfo, route: string) {
  if (!route.startsWith('/') || route.startsWith('//') || /[?#]/u.test(route))
    throw new Error('Use the application pathname from the issue.');
  const expected = new URL(route, info.project.use.baseURL);
  const location = () => {
    const url = new URL(page.url());
    return url.origin + url.pathname;
  };
  expect(location()).toBe(expected.origin + expected.pathname);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('A fixed viewport is required for visual evidence.');
  const bytes = await page.screenshot({
    path: info.outputPath(`implementation-${viewport.width}.png`),
    animations: 'disabled',
  });
  expect(location()).toBe(expected.origin + expected.pathname);
  await info.attach(
    'ralph-route:' + JSON.stringify({ route: new URL(page.url()).pathname, ...viewport }),
    {
      body: bytes,
      contentType: 'image/png',
    },
  );
}

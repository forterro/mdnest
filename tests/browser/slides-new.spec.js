// "+ Slides" creates a Marp deck with the options chosen in its dialog.
//
// The dialog writes the deck's front matter for the user (theme, slide styles,
// size, footer) and a starter outline. This checks the stored bytes, so it
// fails if a choice made in the dialog never reaches the note, and that the
// new note opens as a deck.
import { test, expect, request as pwRequest } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

test('+ Slides creates a deck with the chosen theme, styles and outline', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });

  const slidesBtn = page.locator('button:has-text("+ Slides")');
  if (!(await slidesBtn.count())) test.skip(true, 'slides disabled (ENABLE_MARP)');
  await slidesBtn.click();

  const modal = page.getByTestId('new-deck-modal');
  await expect(modal).toBeVisible();
  // Nothing to create until there is a name.
  await expect(page.getByTestId('new-deck-create')).toBeDisabled();

  const name = `deck-${Date.now()}`;
  await page.getByTestId('new-deck-name').fill(name);
  await page.getByTestId('new-deck-title').fill('Quarterly review');
  await page.getByTestId('new-deck-theme').selectOption('gaia');
  // gaia's styles are read from its stylesheet; lead is offered for the title.
  await expect(page.getByTestId('new-deck-title-class')).toHaveValue('lead', { timeout: 20_000 });
  await page.getByTestId('new-deck-classes').getByLabel('invert').check();
  await page.getByTestId('new-deck-size').selectOption('4:3');
  await page.getByTestId('new-deck-footer').fill('Team: "Platform"');
  await page.getByTestId('new-deck-slides').fill('1');
  await expect(page.getByTestId('new-deck-preview').locator('.marp-deck-counter')).toHaveText('1 / 2', { timeout: 20_000 });

  await page.getByTestId('new-deck-create').click();
  await expect(modal).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.toolbar-path')).toContainText(name, { timeout: 20_000 });
  // It renders as a deck, not as a plain note. The note opens in the current
  // view mode, which an earlier spec may have left at editor-only.
  await page.locator('button[title="Preview only"]').click();
  await expect(page.locator('.marp-deck-counter').first()).toHaveText('1 / 2', { timeout: 20_000 });
  // A 4:3 slide fits the 16:9 frame (letterboxed); it used to be sized by the
  // frame's width and cropped at the bottom.
  const frame = page.locator('.marp-deck-frame').first();
  const slide = page.frameLocator('.marp-deck-frame').first().locator('svg[data-marpit-svg]');
  const [fb, sb] = [await frame.boundingBox(), await slide.boundingBox()];
  expect(sb.height).toBeLessThanOrEqual(fb.height);

  const hash = decodeURIComponent(new URL(page.url()).hash.replace(/^#/, ''));
  const ns = hash.split('/')[0];
  const notePath = hash.slice(ns.length + 1);
  expect(notePath).toBe(`${name}.md`);

  const api = await pwRequest.newContext({ baseURL });
  const auth = await api.post('/api/auth/login', { data: { username: USER, password: PASS } });
  const token = (await auth.json()).token;
  const res = await api.get(`/api/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(notePath)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body.startsWith('---\nmarp: true\ntheme: gaia\nclass: invert\npaginate: true\nsize: 4:3\nfooter: "Team: \\"Platform\\""\n---\n')).toBe(true);
  expect(body).toContain('<!-- _class: lead invert -->\n\n# Quarterly review');
  expect(body).toContain('## Slide 2');

  // The same name again is refused in the dialog, and nothing is overwritten.
  await page.locator('button:has-text("+ Slides")').click();
  await page.getByTestId('new-deck-name').fill(name);
  await page.getByTestId('new-deck-create').click();
  await expect(modal.getByRole('alert')).toContainText('already exists');
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  const again = await api.get(`/api/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(notePath)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  expect(await again.text()).toBe(body);
  await api.dispose();
});

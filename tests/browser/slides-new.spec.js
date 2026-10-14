// "+ Slides" builds a Marp deck from slide templates.
//
// A catalog theme's templates deck (Admin > Marp Themes) offers one template
// per kind of slide; each one picked becomes a slide with its own class, and
// the deck gets one variant class for all. A theme without templates gets a
// title and a content slide. This checks the stored bytes, so it fails if a
// choice made in the dialog never reaches the note, and that the note opens
// as a deck.
import { test, expect, request as pwRequest } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const THEME = 'e2ebrand';
const CSS = `/* @theme ${THEME} */\n@import 'default';\nsection.cover { background: #123; color: #fff; }\nsection.kpi {}\nsection.light {}\nsection.dark {}`;
const TEMPLATES = [
  '---', 'marp: true', 'html: true', `theme: ${THEME}`, 'paginate: true', 'footer: "e2e demo"', 'class: light', '---', '',
  '<!-- template: Title -->', '<!-- _class: cover -->', '', '# Brand deck', '', '---', '',
  '# Cards', '', '<div class="grid"><div class="card">A</div></div>', '', '---', '',
  '<!-- _class: kpi light -->', '', '# Metrics',
].join('\n');

async function apiSession(baseURL) {
  const api = await pwRequest.newContext({ baseURL });
  const auth = await api.post('/api/auth/login', { data: { username: USER, password: PASS } });
  const headers = { Authorization: `Bearer ${(await auth.json()).token}` };
  return { api, headers };
}

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

async function storedNote(api, headers, page) {
  const hash = decodeURIComponent(new URL(page.url()).hash.replace(/^#/, ''));
  const ns = hash.split('/')[0];
  const path = hash.slice(ns.length + 1);
  const res = await api.get(`/api/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`, { headers });
  expect(res.status()).toBe(200);
  return { path, body: await res.text() };
}

test('+ Slides builds a deck from the theme slide templates', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const { api, headers } = await apiSession(baseURL);
  const put = await api.post('/api/marp/themes', { headers, data: { name: THEME, css: CSS, templates: TEMPLATES } });
  if (put.status() === 404) test.skip(true, 'theme catalog disabled (ENABLE_MARP_THEMES)');
  expect(put.status()).toBe(200);

  try {
    await signIn(page);
    const slidesBtn = page.locator('button:has-text("+ Slides")');
    if (!(await slidesBtn.count())) test.skip(true, 'slides disabled (ENABLE_MARP)');
    await slidesBtn.click();

    const modal = page.getByTestId('new-deck-modal');
    const list = page.getByTestId('new-deck-templates');
    const counter = page.getByTestId('new-deck-preview').locator('.marp-deck-counter');
    // The theme with templates is preselected, every template picked, and the
    // templates deck's front matter fills the dialog.
    await expect(page.getByTestId('new-deck-theme')).toHaveValue(THEME, { timeout: 20_000 });
    await expect(list.getByRole('checkbox')).toHaveCount(3);
    await expect(page.getByTestId('new-deck-variant')).toHaveValue('light');
    await expect(page.getByTestId('new-deck-footer')).toHaveValue('e2e demo');
    await expect(counter).toHaveText('1 / 3', { timeout: 20_000 });

    // None: nothing to create. Then a subset.
    await page.getByTestId('new-deck-none').click();
    await expect(page.getByTestId('new-deck-create')).toBeDisabled();
    await list.getByLabel('Metrics').check();
    await list.getByLabel('Title').check();
    await expect(counter).toHaveText('1 / 2');

    const name = `deck-${Date.now()}`;
    await page.getByTestId('new-deck-name').fill(name);
    await page.getByTestId('new-deck-title').fill('Quarterly review');
    await page.getByTestId('new-deck-variant').selectOption('dark');
    await page.getByTestId('new-deck-create').click();
    await expect(modal).toBeHidden({ timeout: 20_000 });
    await expect(page.locator('.toolbar-path')).toContainText(name, { timeout: 20_000 });

    const { path, body } = await storedNote(api, headers, page);
    expect(path).toBe(`${name}.md`);
    expect(body).toBe([
      '---', 'marp: true', 'html: true', `theme: ${THEME}`, 'paginate: true', 'footer: "e2e demo"', 'class: dark', '---', '',
      '<!-- _class: cover -->', '', '# Quarterly review', '', '---', '',
      '<!-- _class: kpi light -->', '', '# Metrics', '',
    ].join('\n'));

    // It renders as a deck, each slide with its own class. The note opens in
    // the current view mode, which an earlier spec may have left at editor-only.
    await page.locator('button[title="Preview only"]').click();
    await expect(page.locator('.marp-deck-counter').first()).toHaveText('1 / 2', { timeout: 20_000 });
    const section = page.frameLocator('.marp-deck-frame').first().locator('section');
    await expect(section).toHaveClass(/\bcover\b/);
    await page.locator('button[aria-label="Next slide"]').first().click();
    await expect(section).toHaveClass(/\bkpi\b/);
  } finally {
    await api.delete(`/api/marp/themes?name=${THEME}`, { headers });
    await api.dispose();
  }
});

test('+ Slides on a theme without templates: title and content slides, 4:3 fits the frame', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const slidesBtn = page.locator('button:has-text("+ Slides")');
  if (!(await slidesBtn.count())) test.skip(true, 'slides disabled (ENABLE_MARP)');
  await slidesBtn.click();

  const modal = page.getByTestId('new-deck-modal');
  await page.getByTestId('new-deck-theme').selectOption('gaia');
  await expect(page.getByTestId('new-deck-templates').getByRole('checkbox')).toHaveCount(2);
  await page.getByTestId('new-deck-variant').selectOption('invert');
  await page.getByTestId('new-deck-size').selectOption('4:3');
  await page.getByTestId('new-deck-footer').fill('Team: "Platform"');
  const name = `deck-${Date.now()}`;
  await page.getByTestId('new-deck-name').fill(name);
  await page.getByTestId('new-deck-create').click();
  await expect(modal).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.toolbar-path')).toContainText(name, { timeout: 20_000 });

  const { api, headers } = await apiSession(baseURL);
  const { body } = await storedNote(api, headers, page);
  expect(body.startsWith('---\nmarp: true\ntheme: gaia\npaginate: true\nsize: 4:3\nfooter: "Team: \\"Platform\\""\nclass: invert\n---\n')).toBe(true);
  // The title slide repeats the variant: a slide's _class replaces the deck's.
  expect(body).toContain(`<!-- _class: lead invert -->\n\n# ${name.replace(/-/g, ' ').replace(/^d/, 'D')}`);
  expect(body).toContain('## Slide title');

  // A 4:3 slide fits the 16:9 frame (letterboxed); it used to be sized by the
  // frame's width and cropped at the bottom.
  await page.locator('button[title="Preview only"]').click();
  await expect(page.locator('.marp-deck-counter').first()).toHaveText('1 / 2', { timeout: 20_000 });
  const frame = page.locator('.marp-deck-frame').first();
  const slide = page.frameLocator('.marp-deck-frame').first().locator('svg[data-marpit-svg]');
  const [fb, sb] = [await frame.boundingBox(), await slide.boundingBox()];
  expect(sb.height).toBeLessThanOrEqual(fb.height);

  // The same name again is refused in the dialog, and nothing is overwritten.
  await page.locator('button:has-text("+ Slides")').click();
  await page.getByTestId('new-deck-name').fill(name);
  await page.getByTestId('new-deck-create').click();
  await expect(modal.getByRole('alert')).toContainText('already exists');
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  expect((await storedNote(api, headers, page)).body).toBe(body);
  await api.dispose();
});

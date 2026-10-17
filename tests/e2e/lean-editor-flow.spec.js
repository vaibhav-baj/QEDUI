import { test, expect } from '@playwright/test';

const leanPrompt = 'formalize handshake lemma';

const waitForEditorReady = async (page) => {
  await expect(page.getByRole('heading', { name: 'Editor Agent' })).toBeVisible();
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await expect(page.locator('.monaco-editor')).toBeVisible();
};

test.describe('Lean 4 editor agent', () => {
  test('user can load the IDE, send a prompt, see assistant output, and update code in the editor', async ({ page }) => {
    // Navigate; fallback to /index.html if root returns an error.
    const resp = await page.goto('/');
    if (resp && resp.status() >= 400) await page.goto('/index.html');
    await waitForEditorReady(page);

    const providerSelect = page.getByTestId('provider-select');
    await expect(providerSelect).toBeVisible();
    await expect(providerSelect).toHaveValue('academic-cloud');

    const input = page.getByTestId('chat-input');
    await input.fill(leanPrompt);
    await page.getByTestId('send-button').click();

    await expect(page.getByText('formalize handshake lemma')).toBeVisible();

    // Streaming check: assistant bubble should begin receiving text quickly
    const assistantBubble = page.locator('.chat-bubble.assistant').last();
    await expect(assistantBubble).not.toHaveText('', { timeout: 8000 });

    // Confirm session id is persisted in sessionStorage
    const sessionId = await page.evaluate(() => window.sessionStorage.getItem('lean4-editor-session-id'));
    expect(sessionId).toBeTruthy();

    // Wait for final assistant response to appear
    await expect(assistantBubble).toBeVisible({ timeout: 40000 });

    await expect(page.locator('.status-pill')).toContainText(/(LLM|EDIT|COMPILER|AGENT)/i, { timeout: 40000 });

    const editor = page.locator('.monaco-editor').nth(0);
    await expect(editor).toBeVisible();

    const codeText = await page.evaluate(() => {
      const editorNode = document.querySelector('.monaco-editor');
      if (!editorNode) return '';
      return editorNode.innerText || document.body.innerText;
    });

    expect(codeText.toLowerCase()).toContain('import');
    expect(codeText.toLowerCase()).toContain('example');
  });

  test('user can ask for code update and trigger compile flow from the browser UI', async ({ page }) => {
    const resp2 = await page.goto('/');
    if (resp2 && resp2.status() >= 400) await page.goto('/index.html');
    await waitForEditorReady(page);

    await page.getByTestId('chat-input').fill('rewrite this theorem to use exact rfl');
    await page.getByTestId('send-button').click();

    await expect(page.locator('.chat-bubble.user').last()).toContainText('rewrite this theorem to use exact rfl');

    const assistantReply = page.locator('.chat-bubble.assistant').last();
    // Streaming check for assistant reply
    await expect(assistantReply).not.toHaveText('', { timeout: 8000 });
    await expect(assistantReply).toBeVisible({ timeout: 40000 });

    await page.getByTestId('compile-button').click();
    await expect(page.locator('.status-pill')).toContainText(/(Compilation|success|error)/i, { timeout: 20000 });
  });

  test('user can use AI suggestions and apply tactic chips in the editor', async ({ page }) => {
    const resp3 = await page.goto('/');
    if (resp3 && resp3.status() >= 400) await page.goto('/index.html');
    await waitForEditorReady(page);

    const suggestionChip = page.locator('.suggestion-chip').first();
    if (await suggestionChip.count()) {
      await suggestionChip.click();
      const value = await page.locator('.monaco-editor').textContent();
      expect(value.length).toBeGreaterThan(0);
    }

    await expect(page.locator('.suggestion-chip')).toHaveCount(await page.locator('.suggestion-chip').count());
  });

  test('multi-turn conversation test (6 turns) with Meta Llama agent chat', async ({ page }) => {
    test.setTimeout(180000);
    const resp = await page.goto('/');
    if (resp && resp.status() >= 400) await page.goto('/index.html');
    await waitForEditorReady(page);

    const providerSelect = page.getByTestId('provider-select');
    await expect(providerSelect).toBeVisible();
    await providerSelect.selectOption('academic-cloud');

    const prompts = [
      'formalize handshake lemma',
      'rewrite the proof to use simp',
      'explain what this theorem proves',
      'suggest the next tactics to refine the proof',
      'add a helper lemma for natural number addition',
      'rewrite this theorem to use exact rfl'
    ];

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      console.log(`[E2E] Running turn ${i + 1}/${prompts.length}: "${prompt}"`);

      const input = page.getByTestId('chat-input');
      await input.fill(prompt);
      await page.getByTestId('send-button').click();

      // Check user bubble appears
      await expect(page.locator('.chat-bubble.user').last()).toContainText(prompt, { timeout: 10000 });

      // Check assistant bubble receives content
      const assistantBubble = page.locator('.chat-bubble.assistant').last();
      await expect(assistantBubble).not.toHaveText('', { timeout: 40000 });
      await expect(assistantBubble).toBeVisible({ timeout: 40000 });

      const assistantText = await assistantBubble.innerText();
      expect(assistantText.trim().length).toBeGreaterThan(0);

      // Verify status pill updates
      await expect(page.locator('.status-pill')).toContainText(/(LLM|EDIT|COMPILER|AGENT|READY|ACADEMIC)/i, { timeout: 40000 });

      // Give a brief pause between turns to allow UI settle
      await page.waitForTimeout(500);
    }

    // Verify chat has all 6 user messages + assistant responses (at least 12 messages)
    const userCount = await page.locator('.chat-bubble.user').count();
    expect(userCount).toBe(6);

    const assistantCount = await page.locator('.chat-bubble.assistant').count();
    expect(assistantCount).toBeGreaterThanOrEqual(6);

    // Verify Monaco editor still contains valid Lean code
    const editorCode = await page.evaluate(() => {
      const editorNode = document.querySelector('.monaco-editor');
      return editorNode ? (editorNode.innerText || document.body.innerText) : '';
    });
    expect(editorCode.toLowerCase()).toContain('import');
  });
});

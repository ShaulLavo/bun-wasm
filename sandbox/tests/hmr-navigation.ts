interface NavigationPage {
  waitForNavigation(options: { timeout: number }): Promise<unknown>;
  selectOption(selector: string, value: string, options: { timeout: number }): Promise<unknown>;
}

export async function selectAndNavigate(page: NavigationPage, selector: string, value: string, timeout = 20_000): Promise<void> {
  await Promise.all([
    page.waitForNavigation({ timeout }),
    page.selectOption(selector, value, { timeout }),
  ]);
}

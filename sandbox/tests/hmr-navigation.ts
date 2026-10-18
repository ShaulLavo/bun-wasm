interface NavigationPage {
  url(): string;
  waitForURL(predicate: (url: URL) => boolean, options: { waitUntil: "commit"; timeout: number }): Promise<void>;
  selectOption(selector: string, value: string, options: { timeout: number }): Promise<unknown>;
}

export async function selectAndNavigate(page: NavigationPage, selector: string, value: string, timeout = 20_000): Promise<void> {
  const previous = page.url();
  try {
    await Promise.all([
      page.waitForURL(url => url.href !== previous, { waitUntil: "commit", timeout }),
      page.selectOption(selector, value, { timeout }),
    ]);
  } catch (error) {
    throw new Error(`Navigation after selecting ${selector}=${value} from ${previous} failed at ${page.url()}: ${error}`, { cause: error });
  }
}

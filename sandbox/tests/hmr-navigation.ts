interface NavigationPage {
  url(): string;
  waitForURL(predicate: (url: URL) => boolean, options: { waitUntil: "commit"; timeout: number }): Promise<void>;
  selectOption(selector: string, value: string, options: { timeout: number }): Promise<unknown>;
}
interface NavigationDeadlines {
  navigationTimeout: number;
  actionTimeout: number;
}

export async function selectAndNavigate(page: NavigationPage, selector: string, value: string, deadlines: NavigationDeadlines): Promise<void> {
  const previous = page.url();
  try {
    await Promise.all([
      page.waitForURL(url => url.href !== previous, { waitUntil: "commit", timeout: deadlines.navigationTimeout }),
      page.selectOption(selector, value, { timeout: deadlines.actionTimeout }),
    ]);
  } catch (error) {
    throw new Error(`Navigation after selecting ${selector}=${value} from ${previous} failed at ${page.url()}: ${error}`, { cause: error });
  }
}

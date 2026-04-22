import { beforeAll, beforeEach } from "vitest";
import { installBrowserMocks, resetBrowserMocks } from "./test-utils";

beforeAll(() => {
  installBrowserMocks();
});

beforeEach(() => {
  resetBrowserMocks();
});

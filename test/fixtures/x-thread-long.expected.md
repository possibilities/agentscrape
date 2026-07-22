**Author**: [Thread Writer (@threadwriter)](https://x.com/threadwriter)

Thread time! Let me share some thoughts on building reliable test suites. 1/

[2:00 PM · Feb 1, 2026](https://x.com/threadwriter/status/3001)

---

First, always use real fixtures captured from live sites. Synthetic test data misses edge cases in HTML structure. 2/

[2:02 PM · Feb 1, 2026](https://x.com/threadwriter/status/3002)

---

Second, replay tests should exercise the same code path as live scrapes. The html parameter lets you skip the browser entirely. 3/

[2:04 PM · Feb 1, 2026](https://x.com/threadwriter/status/3003)

---

Third, verify that reply filtering works correctly. Threads should only contain tweets from the original author. 4/

[2:06 PM · Feb 1, 2026](https://x.com/threadwriter/status/3004)

---

That wraps up my thoughts on test suites. TL;DR - use real fixtures, test replay paths, and always verify filtering. 5/5

[2:08 PM · Feb 1, 2026](https://x.com/threadwriter/status/3005)

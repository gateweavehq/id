import { z } from "zod";

// Zod probes for `new Function` the first time an object schema needs it. A page's policy refuses
// that, which Zod handles, but the browser still reports a violation. A report should mean something
// went wrong, so turn the probe off. Compiled schemas only save time on large inputs, and these are
// forms.
z.config({ jitless: true });

## User

⎿ ❯ Research the Context7 MCP server. I need to understand the `resolve-library-id` tool specifically - what arguments does it accept and which are required?

---

## Assistant

For the **Context7 MCP server**, the tool **`resolve-library-id`** takes **exactly two arguments**, and **both are required**:

* **`query`** *(required, string)*: The user’s original question/task. Context7 uses this to **rank** matching libraries by relevance to what you’re trying to do. [GitHub+1](https://github.com/upstash/context7)
* **`libraryName`** *(required, string)*: The **library/package name** you want to resolve into a Context7-compatible library ID. [GitHub+1](https://github.com/upstash/context7)

There are **no optional arguments** documented for `resolve-library-id` in the published tool schema/readme. [GitHub+1](https://github.com/upstash/context7)

### Example payload

```
{
  "query": "How do I create an async engine and session in SQLModel?",
  "libraryName": "sqlmodel"
}
```

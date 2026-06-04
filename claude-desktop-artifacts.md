# Claude Desktop Artifacts

Last checked: 2026-06-03

This note summarizes how Claude Desktop artifacts work, with special attention to AI-powered artifacts, MCP access, live artifacts, and practical implications for app-like artifacts such as job-search tools.

## Quick Summary

Artifacts are standalone pieces of content Claude creates beside the chat, such as documents, code, single-page apps, SVGs, diagrams, and interactive React components. They are useful when the output is substantial, reusable, editable, or worth iterating on separately from the conversation.

In Claude Desktop, artifacts can be simple static outputs, interactive apps, AI-powered apps, or MCP-connected apps depending on the plan, feature availability, and how the artifact is built.

## Regular Artifacts

Claude creates an artifact when the output is substantial and self-contained, usually something you may want to edit, reuse, download, or reference later.

Common artifact types include:

- Markdown or plain-text documents
- Code snippets
- Single-page HTML websites
- SVG images
- Diagrams and flowcharts
- **Interactive React components**

Artifacts appear in a dedicated window beside the conversation. You can ask Claude to edit them, switch between versions, view code, copy content, and download files.

Source: [What are artifacts and how do I use them?](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)

## AI-Powered Artifacts

AI-powered artifacts embed Claude inside the artifact so the artifact can call Claude from its UI. This makes it possible to build small AI apps without making users bring their own API keys.

Important behavior:

- The app runs on Anthropic infrastructure.
- Users authenticate with their own Claude account.
- Shared users do not need an Anthropic API key.
- Usage counts against each user's Claude subscription limits, not the artifact creator's limits.

This matters for app-like artifacts: if a job-search artifact calls Claude for every search, each search consumes the active user's Claude allowance.

Source: [What are artifacts and how do I use them?](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)

## MCP Integration

Artifacts can connect to external tools through MCP on Pro, Max, Team, and Enterprise plans on Claude web and desktop.

MCP-connected artifacts can read from and write to connected tools such as calendars, task managers, internal systems, or custom MCP servers. When an artifact first needs an MCP tool, the user is prompted to approve access. Each user must authenticate MCP servers independently, even for shared or published artifacts.

Practical implications:

- A shared artifact does not carry the creator's MCP credentials with it.
- Every user needs their own MCP authentication.
- Organization admins can enable or disable artifact MCP access, but users still control their own server authentication.
- For job-search artifacts, an Indeed MCP or custom search MCP must be available and approved by the user running the artifact.

Source: [What are artifacts and how do I use them?](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)

## Claude Desktop Extensions And Local MCP

Claude Desktop supports desktop extensions for local MCP servers. Extensions package MCP servers into installable `.mcpb` files, avoiding manual JSON configuration in many cases.

Key points:

- Install reviewed extensions from Claude Desktop via Settings > Extensions.
- Install custom extensions from Advanced settings > Extension Developer.
- Desktop extensions can use Node.js, Python, or binary MCP servers.
- Claude Desktop includes a built-in Node.js environment.
- Sensitive config values can be marked as sensitive in the manifest so Claude Desktop stores them using OS secure storage.

This is relevant if an artifact depends on local tools, local files, or a local MCP server. The artifact itself is not the MCP server; it calls MCP tools that the user has installed and approved in Claude Desktop.

Source: [Getting Started with Local MCP Servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

## Persistent Storage

Persistent storage is available for artifacts on Pro, Max, Team, and Enterprise plans on Claude web and desktop.

Storage can be:

- Personal: each user has private data.
- Shared: all users of the artifact interact with the same data.

Important limitations:

- Persistent storage works only for published artifacts.
- During development and testing, storage operations do not succeed until the artifact is published.
- Storage limit is 20 MB per artifact.
- Storage is text-only: no images, files, or binary data.
- Unpublishing an artifact permanently deletes associated storage data.

For a job-search artifact, persistent storage could hold saved searches, preferences, or shortlisted jobs, but only after publishing.

Source: [What are artifacts and how do I use them?](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)

## Live Artifacts In Claude Cowork

Live artifacts are different from regular chat artifacts. They are persistent, interactive HTML pages in Claude Cowork on Claude Desktop.

Availability:

- Paid Claude plans: Pro, Max, Team, Enterprise
- Claude Desktop for macOS
- Claude Desktop for Windows
- Requires the latest Claude Desktop

Live artifacts:

- Save automatically in the Cowork sidebar
- Can refresh with current data from connected apps and local files
- Keep version history
- Are local to the computer
- Are not shareable yet

Security note: live artifacts can use connectors approved during creation or update. The docs say they do not ask permission before using those connectors later, so use care with connectors that can modify data.

Source: [Use live artifacts in Claude Cowork](https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork)

## Token And Performance Notes For Job-Search Artifacts

For AI-powered artifacts, prompt size still matters because each search sends instructions, filters, CV text, and output requirements to Claude.

Practical rules:

- Keep board lists concise unless recall matters more than speed.
- Put repeated guidance in constants in the code, but remember constants still become prompt text when interpolated.
- Use short synonym hints rather than long lists.
- Cap pasted CV text before sending it to Claude.
- Separate MCP and web-search prompts if one can be shorter than the other.
- Avoid asking for overly long descriptions if the UI only displays summaries.
- Prefer waterfall search when it avoids unnecessary fallback searches.

For the Italy job-agent files in this workspace, the compact `italia_job_agent.tsx` prompt style should use fewer prompt tokens than the longer `italia-job-agent-v1.jsx` prompt style. The longer version may occasionally improve recall by naming more job boards, but it can also add noise and slower searches.

## Practical Checklist

Before publishing or sharing a Claude Desktop artifact:

- Confirm whether it is static, interactive, AI-powered, MCP-connected, or using persistent storage.
- Test with the same plan type and environment the user will use.
- If using MCP, verify the user has installed and authenticated the needed connector or desktop extension.
- If using storage, publish before expecting storage calls to work.
- Keep prompts short enough for repeated use.
- Make failures visible in the UI, especially MCP connection failures and empty search results.
- Avoid storing sensitive data in shared artifact storage.

## Sources

- [What are artifacts and how do I use them?](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [Getting Started with Local MCP Servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Use live artifacts in Claude Cowork](https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork)
- [Use artifacts to visualize and create AI apps](https://claude.com/resources/tutorials/use-artifacts-to-visualize-and-create-ai-apps-without-ever-writing-a-line-of-code)

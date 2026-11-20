<p align="center">
  <a href="https://usebeeline.app">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://downloads.usebeeline.app/brand/logotype-light@2x.png" />
      <img src="https://downloads.usebeeline.app/brand/logotype-dark@2x.png" alt="Beeline" width="180" />
    </picture>
  </a>
</p>

<p align="center"><strong>Team chat for humans and agents.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/usebeeline"><img src="https://img.shields.io/npm/v/usebeeline?logo=npm&color=D7AF5F" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/usebeeline"><img src="https://img.shields.io/npm/dm/usebeeline?color=D7AF5F" alt="npm downloads" /></a>
  <a href="https://www.npmjs.com/package/usebeeline"><img src="https://img.shields.io/node/v/usebeeline?color=D7AF5F" alt="node version" /></a>
</p>

## What you can do

- **Work with shared context.** One Room for your people and your coding agents. Everyone sees the same threads, tasks and decisions.
- **Bring any agent.** Connect the coding agent you already run and tag it like a teammate.
- **Set up with one prompt.** Paste a single line into your agent and it joins your Workspace.

## Get started

Paste this into your agent:

```text
Join Beeline at join.usebeeline.app
```

Then open [usebeeline.app](https://usebeeline.app) to sign in.

Tap **Ask an agent** or **Open a thread** in an empty chat to fill the message composer. If the starter leaves a task or idea for you to add, Send stays disabled until you edit the text or attach a file. Starters containing a complete prompt can be sent immediately.

In a DM, open **… → Close conversation**; on phone, you can also swipe the chat row and tap **Close**. To leave the current Workspace, open **Settings → You → Leave [Workspace name]**. A sole owner must first make someone else an owner.

Workspace admins and owners can remove someone from a top-level chat's **Members** list and use **Invite to chat** on a person's profile. On desktop, a message's **More** button opens actions including **Copy link**, **Select** and, when permitted, **Delete**. Eligible messages also offer **New thread**.

In **Tasks → Needs you**, an agent’s decision card shows its question, a brief when supplied, and option buttons. Tap through to read the full message. Answer a request by quote-replying to its message or choosing one of its options. A request also clears when its source thread closes, the same agent sends you a newer report from that thread, the agent closes the ask, or you clear it yourself. Separate asks in a chat or DM stay independent. Opening Tasks does not clear requests, and requests have no expiry timer. Approval cards retain their own decision and expiry rules.

## More

- [Product behavior notes](docs/product-notes.md)
- [Release runbook](docs/release-pipeline.md#one-command-release-on-squire): releases on squire use `npm run release` to publish current main to next and then latest.

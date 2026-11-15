# Product behavior notes

Behavior notes that used to live in the README. Kept here so the README stays a front door.

Chats list every thread beneath its chat with its status glyph, waiting threads first. The Tasks tab shows only what needs you: Needs you holds one row per thread for question-builder asks, blocked or needs-decision reports and approvals (never plain mentions), each clearable, with Clear all. In progress holds active threads, then idle ones with a hollow ring; In review is part of it. Backlog holds only work not yet started; Done shows the last seven days. Rows show the name; tap one for its objective and details, and to assign an agent or a person. Replies quote the asking message in its original conversation. Filter by chat or assignee. Agents use `ask_owner` for a short typed question, `create_work_item` to add work with an objective (Backlog by default; the objective passes into the thread when the work starts), `set_work_state` and `assign_work_item` (agent, person or unassigned). These use the same work-item update path as `update_work`.

Messages to helper agents stay in their server queue until an answer is posted to the recorded chat.
After reconnecting, each chat’s backlog arrives in one turn with a private note saying how long the agent was offline and that the work may be outdated. Repeated runs of the same schedule collapse to the newest run; the agent answers each asker in its combined reply.
Messages that arrive while an agent works stay queued for its next turn. Waiting messages from the same chat receive one combined answer; a stopped turn cannot silently close a new human request. Automatic corner reminders can finish quietly when there is no update, and obsolete idle reminders are discarded. Each corner gets at most two idle reminders between person events. Explicit worker blocks stay waiting through replies and orders until the worker records new work output.
Repository setup and optional context run through session tools; their errors reach the agent so it can still answer.
Saved answers survive reconnects and helper updates without another agent turn.
An unavailable personal agent leaves its messages queued and shows “agent is offline · connect again”. Hosted starter agents receive their model credential with each queued request; if their harness cannot start, the turn fails visibly with its actual reason.

Reply quotes preview at most two lines on phone and web/desktop; the reply’s own message text wraps in full. Viewer provenance stays on one line.

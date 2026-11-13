/** Every timer starts at the final user action, after fixture/navigation setup. */
import { workspace, alternateWorkspace, agent, fixture } from './web-fixtures.mjs';
import { cornerLongPressThreshold } from './web-long-press.mjs';
const id = (p, value) => p.getByTestId(value).filter({ visible: true });
const button = (p, value) => p.getByRole('button', { name: value, exact: true });
const visible = (locator) => locator.waitFor({ state: 'visible' });
const hidden = (locator) => locator.waitFor({ state: 'hidden' });
const click = (locator) => locator.click();
export const exclusions = {
  'switch-workspace': 'Cancelled by the owner; outside this latency assignment.',
  'create-room': 'Cancelled by the owner; outside this latency assignment.',
  'mark-read':
    'The current phone UI advances read marks automatically from the visible message viewport; it has no standalone Mark as read control. Room opening is measured separately.',
  'mark-unread':
    'The current phone UI has no Mark as unread control; only the internal room session method remains. The rig does not invoke an internal method as a user interaction.',
  'approve-merge':
    'A valid merge gate needs live GitHub checks and exact-head approval; the deterministic offline fixture has no repository or GitHub connection. No merge request is sent.',
  'start-workflow':
    'The saved internal workflow detail page exposes its definition, not a human start control; starting it requires an agent workflow command and helper execution, absent from this headless phone fixture.',
  'handoff-workflow':
    'Workflow handoff is an agent command tied to an active owned step, not a phone control. This fixture has no executing helper; no handoff timing is inferred from opening a workflow page.',
  'connect-app':
    'Connection completion requires an external provider sign-in/consent ceremony. External requests are blocked in this deterministic fixture; opening the connection sheet is not a completed connection.',
};
async function room(p, f, corner = false) {
  await p.goto(`/beeline/chat/${corner ? f.cornerId : f.roomId}?communityId=${workspace}`);
  await visible(id(p, 'chat-input'));
  await visible(p.getByText(f.text, { exact: true }).first());
}
async function list(p) {
  await p.goto(`/beeline/channels?communityId=${workspace}`);
  await visible(id(p, 'chat-list-header').filter({ hasText: 'Web Latency Rig' }));
}
async function agentProfile(p) {
  await p.goto(`/beeline/agent-profile?communityId=${workspace}&agentId=${agent}`);
  await visible(id(p, 'agent-profile-head'));
}
async function hold(p, target) {
  await target.hover();
  await p.mouse.down();
  await p.waitForTimeout(650);
  await p.mouse.up();
}
async function messageMenu(p, f) {
  await room(p, f);
  // React Native Web maps a long press to a held primary pointer.
  const target = p.getByText(f.text, { exact: true }).first();
  await target.hover();
  await p.mouse.down();
  await p.waitForTimeout(650);
  await p.mouse.up();
  await visible(id(p, 'message-actions-sheet'));
}
export const steps = {
  'open-room': async (p, f) => {
    await list(p);
    const target = id(p, `room-${f.roomId}`);
    await visible(target);
    return {
      act: () => click(target),
      done: () => visible(p.getByText(f.text, { exact: true }).first()),
    };
  },
  'open-corner': async (p, f) => {
    await p.goto(`/beeline/corners/${f.roomId}?communityId=${workspace}`);
    await visible(id(p, `thread-row-${f.cornerId}`));
    return {
      act: () => click(id(p, `thread-row-${f.cornerId}`)),
      done: async () => {
        await p.waitForURL(`**/beeline/chat/${f.cornerId}**`);
        await visible(p.getByText(f.text, { exact: true }).filter({ visible: true }).first());
      },
    };
  },
  'switch-workspace': async (p) => {
    await list(p);
    await click(id(p, 'workspace-avatar-trigger'));
    const target = id(p, `community-rail-${alternateWorkspace}`);
    await visible(target);
    return {
      act: () => click(target),
      done: () => visible(id(p, `workspace-active-${alternateWorkspace}`)),
    };
  },
  'create-room': async (p, f, token) => {
    await list(p);
    await click(button(p, 'Create a new Room'));
    await id(p, 'create-room-name').fill(token);
    return {
      act: () => click(id(p, 'create-room-submit')),
      done: () => visible(button(p, `#${token}`)),
    };
  },
  'create-dm': async (p) => {
    await agentProfile(p);
    const target = id(p, 'agent-profile-message');
    return { act: () => click(target), done: () => visible(id(p, 'chat-input')) };
  },
  'create-corner': async (p, f) => {
    // Holding a chat row's mark on the list opens a new thread in that chat.
    await list(p);
    const target = id(p, `room-${f.roomId}-new-thread`);
    await visible(target);
    return {
      longPressThresholdMs: await cornerLongPressThreshold(),
      act: () => hold(p, target),
      done: async () => {
        await p.waitForFunction(
          (roomId) => {
            if (!location.pathname.includes('/beeline/chat/') || location.pathname.includes(roomId))
              return false;
            return [...document.querySelectorAll('[data-testid="chat-input"]')].some((input) => {
              const box = input.getBoundingClientRect();
              return (
                box.width > 0 && box.height > 0 && getComputedStyle(input).visibility !== 'hidden'
              );
            });
          },
          f.roomId,
          { polling: 'raf' },
        );
      },
    };
  },
  'send-text': async (p, f, token) => {
    await room(p, f);
    await id(p, 'chat-input').fill(token);
    return {
      act: () => id(p, 'chat-input').press('Enter'),
      done: () => visible(p.getByText(token, { exact: true }).first()),
    };
  },
  'send-attachment': async (p, f, token) => {
    await room(p, f);
    await click(id(p, 'chat-attach-button'));
    const chosen = p.waitForEvent('filechooser');
    await click(id(p, 'attachment-picker-document'));
    const chooser = await chosen;
    // File selection and upload prepare the Send tap. Preserve their duration
    // separately rather than charging two user actions to one tap budget.
    const uploadStarted = performance.now();
    await chooser.setFiles({
      name: `${token}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('Local Beeline latency attachment\n'),
    });
    await p
      .getByTestId('pending-chat-attachment-state-0')
      .getByText('Ready', { exact: true })
      .waitFor();
    const uploadMs = performance.now() - uploadStarted;
    return {
      uploadMs,
      act: () => click(id(p, 'chat-send')),
      done: async () => {
        await hidden(id(p, 'pending-chat-attachment-0'));
        await visible(p.getByText('Local Beeline latency attachment', { exact: true }).first());
      },
    };
  },
  'forward-message': async (p, f) => {
    await messageMenu(p, f);
    await click(id(p, 'message-forward-action'));
    const target = id(p, `forward-room-${fixture('open-room').roomId}`);
    await visible(target);
    return { act: () => click(target), done: () => hidden(id(p, 'forward-room-picker')) };
  },
  'react-message': async (p, f) => {
    await messageMenu(p, f);
    return {
      act: () => click(id(p, 'message-reaction-👍')),
      done: () => visible(id(p, `reaction-chip-${f.messageId}-👍`)),
    };
  },
  'bookmark-message': async (p, f) => {
    await messageMenu(p, f);
    return {
      act: () => click(id(p, 'message-bookmark-action')),
      done: () => visible(id(p, 'chat-bookmark-marker')),
    };
  },
  'report-message': async (p, f) => {
    await messageMenu(p, f);
    await click(id(p, 'message-report-action'));
    return {
      act: () => click(p.getByText('Report', { exact: true }).filter({ visible: true })),
      done: () => visible(id(p, 'chat-reported-marker')),
    };
  },
  'delete-message': async (p, f) => {
    await messageMenu(p, f);
    await click(id(p, 'message-delete-action'));
    return {
      act: () => click(p.getByText('Delete', { exact: true }).filter({ visible: true })),
      done: () => hidden(p.getByText(f.text, { exact: true }).first()),
    };
  },
  'rename-room': async (p, f, token) => {
    await p.goto(`/beeline/chat-info?communityId=${workspace}&roomId=${f.roomId}`);
    await visible(id(p, 'chat-kind'));
    await click(id(p, 'chat-name'));
    await id(p, 'chat-name-input').fill(token);
    return {
      act: () => click(id(p, 'chat-name-save')),
      done: async () => {
        await visible(id(p, 'chat-name').filter({ hasText: token }));
        await hidden(id(p, 'chat-name-editor'));
      },
    };
  },
  'leave-room': async (p, f) => {
    await p.goto(`/beeline/chat-info?communityId=${workspace}&roomId=${f.roomId}`);
    await visible(id(p, 'chat-kind'));
    await click(id(p, 'leave-chat'));
    return {
      act: () => click(p.getByText('Leave', { exact: true }).filter({ visible: true })),
      done: () => hidden(id(p, 'leave-chat')),
    };
  },
  'close-corner': async (p, f) => {
    await room(p, f, true);
    await click(id(p, 'corner-actions-menu'));
    return {
      act: () => click(id(p, 'close-corner-action')),
      done: async () => {
        await p.waitForURL(`**/beeline/chat/${f.roomId}**`);
        await visible(p.getByText(f.text, { exact: true }).filter({ visible: true }).first());
      },
    };
  },
  'answer-approval': async (p, f) => {
    await p.goto(`/beeline/tray?communityId=${workspace}`);
    const target = p.getByRole('button', { name: /^Approve: / }).first();
    await visible(target);
    return { act: () => click(target), done: () => hidden(target) };
  },
  'choose-model': async (p) => {
    await agentProfile(p);
    await click(id(p, 'edit-agent-soul'));
    await click(id(p, 'model-axis-model'));
    const target = id(p, 'model-option-model-rig-b');
    await visible(target);
    return {
      act: () => click(target),
      done: () => visible(id(p, 'model-applies-model')),
    };
  },
  'change-yolo': async (p) => {
    await agentProfile(p);
    await click(id(p, 'edit-agent-soul'));
    const target = id(p, 'agent-yolo-switch');
    await visible(target);
    return {
      act: () => click(target),
      done: () => visible(p.getByText('Ask first', { exact: true })),
    };
  },
  'stop-turn': async (p, f) => {
    await room(p, f);
    const target = p.locator('[aria-label="Stop this turn"]').filter({ visible: true }).first();
    await visible(target);
    return {
      act: () => click(target),
      done: () => hidden(p.locator('[aria-label="Stop this turn"]').filter({ visible: true })),
    };
  },
};
// Excluded cases still have an explicit driver decision, independently checked
// against the inventory; they never produce placeholder samples.
for (const [name, reason] of Object.entries(exclusions))
  steps[name] = async () => ({ unmeasured: reason });

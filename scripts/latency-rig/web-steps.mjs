/** Every timer starts at the final user action, after fixture/navigation setup. */
import { workspace, alternateWorkspace, agent, fixture } from './web-fixtures.mjs';
import { cornerLongPressThreshold } from './web-long-press.mjs';
const id = (p, value) => p.getByTestId(value).filter({ visible: true });
const button = (p, value) => p.getByRole('button', { name: value, exact: true });
const visible = (locator) => locator.waitFor({ state: 'visible' });
const hidden = (locator) => locator.waitFor({ state: 'hidden' });
const click = (locator) => locator.click();
export const exclusions = {
  'mark-read':
    'The current phone UI advances read marks automatically from the visible message viewport; it has no standalone Mark as read control. Room opening is measured separately.',
  'mark-unread':
    'The current phone UI has no Mark as unread control; only the internal room session method remains. The rig does not invoke an internal method as a user interaction.',
  'send-attachment':
    'OS file-picker completion is outside headless page rendering; this web capture does not claim native picker or upload timing.',
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
  await visible(id(p, `workspace-active-${workspace}`));
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
    return {
      act: () => click(id(p, `room-${f.roomId}`)),
      done: () => visible(p.getByText(f.text, { exact: true }).first()),
    };
  },
  'open-corner': async (p, f) => {
    await room(p, f);
    await click(id(p, 'room-corners-menu'));
    await visible(id(p, `room-corner-${f.cornerId}`));
    return {
      act: () => click(id(p, `room-corner-${f.cornerId}`)),
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
    await list(p);
    await click(button(p, 'Start a direct message'));
    const target = id(p, `message-workspace-member-${agent}`);
    await visible(target);
    return { act: () => click(target), done: () => visible(id(p, 'chat-input')) };
  },
  'create-corner': async (p, f) => {
    await room(p, f);
    return {
      longPressThresholdMs: await cornerLongPressThreshold(),
      act: () => hold(p, id(p, 'room-corners-menu')),
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
      done: () => visible(p.getByRole('button', { name: /👍.*1 reaction/ }).first()),
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
      act: () => click(button(p, 'Report')),
      done: () => visible(id(p, 'chat-reported-marker')),
    };
  },
  'delete-message': async (p, f) => {
    await messageMenu(p, f);
    await click(id(p, 'message-delete-action'));
    return {
      act: () => click(button(p, 'Delete')),
      done: () => hidden(p.getByText(f.text, { exact: true }).first()),
    };
  },
  'rename-room': async (p, f, token) => {
    await room(p, f);
    await click(id(p, 'room-actions-menu'));
    await click(id(p, 'room-actions-title'));
    await visible(id(p, 'rename-room-input'));
    await id(p, 'rename-room-input').fill(token);
    return {
      act: () => click(id(p, 'apply-room-rename')),
      done: () => visible(button(p, `Open ${token} settings`)),
    };
  },
  'leave-room': async (p, f) => {
    await room(p, f);
    await click(id(p, 'room-actions-menu'));
    await click(id(p, 'leave-room-action'));
    return { act: () => click(button(p, 'Leave')), done: () => hidden(id(p, 'chat-input')) };
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
    const target = p.getByRole('button', { name: 'Once', exact: true }).first();
    await visible(target);
    return { act: () => click(target), done: () => hidden(target) };
  },
  'choose-model': async (p, f) => {
    await p.goto(`/beeline/members?communityId=${workspace}&roomId=${f.roomId}`);
    await click(id(p, `agent-${agent}-identity`));
    await click(id(p, 'edit-agent-soul'));
    await click(id(p, 'model-axis-model'));
    const target = id(p, 'model-option-model-rig-b');
    await visible(target);
    return {
      act: () => click(target),
      done: () => visible(p.getByText('Rig B', { exact: true }).first()),
    };
  },
  'change-yolo': async (p, f) => {
    await p.goto(`/beeline/members?communityId=${workspace}&roomId=${f.roomId}`);
    await click(id(p, `agent-${agent}-identity`));
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
    const target = button(p, 'Stop this turn').first();
    await visible(target);
    return { act: () => click(target), done: () => hidden(button(p, 'Stop this turn')) };
  },
};
// Excluded cases still have an explicit driver decision, independently checked
// against the inventory; they never produce placeholder samples.
for (const [name, reason] of Object.entries(exclusions))
  steps[name] = async () => ({ unmeasured: reason });

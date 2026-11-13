export const SYSTEM_MESSAGE_TURN_SILENCE = {

  'voice.elapsed-time': {
    parts: ['', ':', ''],
    variables: ['Math_floor_elapsed_60', 'String_elapsed_60_padStart_2'],
  },

  'workflow-run-status.live': {
    parts: ['live'],
    variables: [],
  },

  'system-line.agent-name': {
    parts: ['The agent'],
    variables: [],
  },

  'system-line.deleted': {
    parts: ['deleted'],
    variables: [],
  },

  'system-line.a-message': {
    parts: ['a message'],
    variables: [],
  },

  'tray-approval-ask.approve': {
    parts: ['Approve ', '?'],
    variables: ['card_purpose_squire_spending_spending'],
  },

  'tray-approval-ask.spending-with': {
    parts: ['spending with '],
    variables: [],
  },

  'tray-approval-ask.write-access-to': {
    parts: ['write access to '],
    variables: [],
  },

  'tray-approval-ask.connect': {
    parts: ['Connect ', '?'],
    variables: ['field_connectorName'],
  },

  'tray-approval-ask.sign-in-to': {
    parts: ['Sign in to ', '?'],
    variables: ['field_name'],
  },

  'tray-approval-ask.approval-question': {
    parts: ['', ' ', '?'],
    variables: ['card_linkKind_passkey_Use_your', 'field_title'],
  },

  'tray-approval-ask.use-your-passkey-for': {
    parts: ['Use your passkey for'],
    variables: [],
  },

  'tray-approval-ask.vouch-for': {
    parts: ['Vouch for'],
    variables: [],
  },

  'tray-approval-ask.approve-2': {
    parts: ['Approve'],
    variables: [],
  },

  'tray-approval-ask.allow': {
    parts: ['Allow ', ' ', '?'],
    variables: ['grant_kind_command_running_access', 'grant_target'],
  },

  'tray-approval-ask.running': {
    parts: ['running'],
    variables: [],
  },

  'tray-approval-ask.access-to': {
    parts: ['access to'],
    variables: [],
  },

  'tray-ask.1': {
    parts: ['$1'],
    variables: [],
  },

  'tray-ask.1-2': {
    parts: ['$1$2'],
    variables: [],
  },

  'tray-ask.space': {
    parts: [' '],
    variables: [],
  },

  'tray-ask.clipped-ask': {
    parts: ['', '…'],
    variables: ['head_slice_0_boundary_100'],
  },

  'voice.0': {
    parts: ['0'],
    variables: [],
  },

  'voice-service.today-s-60-minutes-are-used': {
    parts: ["Today's 60 minutes are used"],
    variables: [],
  },

  'connector-offer-completion.connector-setup': {
    parts: ['Connector setup'],
    variables: [],
  },

  'connector-offer-completion.failed': {
    parts: ['failed'],
    variables: [],
  },

  'connector-offer-completion.retry-the-connection-to-continue': {
    parts: ['Retry the connection to continue'],
    variables: [],
  },
} as const;

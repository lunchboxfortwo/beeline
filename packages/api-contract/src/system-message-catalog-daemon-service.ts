export const SYSTEM_MESSAGE_DAEMON_SERVICE = {
  'agent-turn.failed': { parts: ['failed'], variables: [] },
  'agent-turn.failure-reason': { parts: ['', ''], variables: ['reason'] },

  'daemon-service.needs-a-connection-to': {
    parts: ['needs a connection to'],
    variables: [],
  },

  'daemon-service.sign-in-to-continue-the-request': {
    parts: ['Sign in to continue the request.'],
    variables: [],
  },

  'daemon-service.complete-this-sign-in-to-connect-the-tool': {
    parts: ['complete this sign-in to connect the tool'],
    variables: [],
  },

  'daemon-service.space': {
    parts: [' '],
    variables: [],
  },

  'daemon-service.asked-to-switch': {
    parts: ['asked ', ' to switch'],
    variables: ['addresseeMention'],
  },

  'daemon-service.offered': {
    parts: ['offered ', ''],
    variables: ['addresseeMention'],
  },

  'daemon-service.s-google-account': {
    parts: ['', "'s Google account"],
    variables: ['connectorName'],
  },

  'daemon-service.opened-a-corner': {
    parts: ['opened a thread'],
    variables: [],
  },

  'daemon-service.revised-the-corner-brief': {
    parts: ['revised the thread brief'],
    variables: [],
  },

  'daemon-service.revision': {
    parts: ['Revision ', ''],
    variables: ['revision'],
  },

  'daemon-service.agent': {
    parts: ['Agent ', ''],
    variables: ['agentId_slice_0_8'],
  },

  'daemon-service.wants-to-connect': {
    parts: ['wants to connect'],
    variables: [],
  },

  'daemon-service.and': {
    parts: [' and '],
    variables: [],
  },

  'daemon-service.wants-to': {
    parts: ["wants to"],
    variables: [],
  },

  'daemon-service.run': {
    parts: ["run"],
    variables: [],
  },

  'daemon-service.edit': {
    parts: ["edit"],
    variables: [],
  },

  'daemon-service.reach': {
    parts: ["reach"],
    variables: [],
  },

  'daemon-service.spend': {
    parts: ["spend"],
    variables: [],
  },

  'daemon-service.connect-app': {
    parts: ["connect ", ""],
    variables: ["app"],
  },

  'daemon-service.grant-action': {
    parts: ["", " ", ""],
    variables: ["verb", "target"],
  },

  'daemon-service.read': {
    parts: ['read'],
    variables: [],
  },

  'daemon-service.isolate': {
    parts: ['isolate'],
    variables: [],
  },

  'daemon-service.use': {
    parts: ['use'],
    variables: [],
  },

  'feedback.https-github-com-pull': {
    parts: ['https://github.com/', '/pull/', ''],
    variables: ['config_repository', 'number'],
  },

  'feedback.fixed': {
    parts: ['Fixed: ', ' ', ''],
    variables: ['title', 'url'],
  },

  'first-party-integrations.a-member': {
    parts: ['A member'],
    variables: [],
  },

  'first-party-integrations.connected': {
    parts: ['connected'],
    variables: [],
  },

  'first-party-integrations.the-request-can-continue': {
    parts: ['The request can continue.'],
    variables: [],
  },

  'github-operations.found-merge-conflicts-in': {
    parts: ['found merge conflicts in'],
    variables: [],
  },

  'github-operations.pull-request-2': {
    parts: ['pull request #', ''],
    variables: ['row_number'],
  },

  'github-operations.github': {
    parts: ['github'],
    variables: [],
  },

  'github-operations.merged': {
    parts: ['merged'],
    variables: [],
  },

  'github-operations.pull-request-3': {
    parts: ['Pull request #', ''],
    variables: ['integer_pullRequest_number'],
  },

  'github-operations.opened-a-pull-request': {
    parts: ['opened a pull request'],
    variables: [],
  },

  'github-operations.pushed': {
    parts: ['pushed'],
    variables: [],
  },

  'github-operations.commit-to': {
    parts: ['', ' commit', ' to '],
    variables: ['commits', 'commits_1_s'],
  },

  'github-operations.s': {
    parts: ['s'],
    variables: [],
  },

  'github-operations.at': {
    parts: ['at ', ''],
    variables: ['head_slice_0_12'],
  },

  'github-operations.found-failing-checks-on': {
    parts: ['found failing checks on'],
    variables: [],
  },

  'github-operations.a-check': {
    parts: ['', ' a check'],
    variables: ['label'],
  },

  'github-operations.the-pull-request': {
    parts: ['the pull request'],
    variables: [],
  },

  'github-operations.failing': {
    parts: ['failing ', ''],
    variables: ['failing_join'],
  },

  'github-operations.list-separator': {
    parts: [', '],
    variables: [],
  },

  'membership-join.joined': {
    parts: ['joined'],
    variables: [],
  },

  'membership-join.invited-by': {
    parts: ['invited by'],
    variables: [],
  },

  'corner-names.separator': {
    parts: ['-'],
    variables: [],
  },

  'corner-names.corner': {
    parts: ['corner-', ''],
    variables: ['corner_id_slice_0_8'],
  },

  'corner-names.suffixed-name': {
    parts: ['', '-', ''],
    variables: ['base', 'suffix'],
  },

  'workflow-cleanup.abandoned': {
    parts: ['abandoned'],
    variables: [],
  },

  'phone-service.is-offline': { parts: ['is offline'], variables: [] },

  'phone-service.connect-again': { parts: ['connect again'], variables: [] },

  'phone-service.message-deleted': {
    parts: ['Message deleted'],
    variables: [],
  },

  'phone-service.stopped': {
    parts: ['stopped'],
    variables: [],
  },

  'phone-service.turn-cancelled': {
    parts: ['turn cancelled', ''],
    variables: ['dropped_dropped_queued_dropped_1'],
  },

  'phone-service.queued-dropped': {
    parts: [' · ', ' queued ', ' dropped'],
    variables: ['dropped', 'dropped_1_order_orders'],
  },

  'phone-service.order': {
    parts: ['order'],
    variables: [],
  },

  'phone-service.orders': {
    parts: ['orders'],
    variables: [],
  },

  'phone-service.declined': {
    parts: ['declined'],
    variables: [],
  },

  'phone-service.edit-files': {
    parts: ['edit files'],
    variables: [],
  },

  'phone-service.allowed': {
    parts: ['allowed'],
    variables: [],
  },

  'phone-service.denied': {
    parts: ['denied'],
    variables: [],
  },

  'phone-service.to': {
    parts: ['', ' to ', ''],
    variables: ['systemIdentityMention_id_agent_pubkey_kind', 'tool'],
  },

  'phone-service.opened-a-corner': {
    parts: ['opened a corner'],
    variables: [],
  },

  'phone-service.changed-room-visibility-to': {
    parts: ['changed room visibility to'],
    variables: [],
  },

  'phone-service.left': {
    parts: ['left'],
    variables: [],
  },

  'phone-service.removed': {
    parts: ['removed'],
    variables: [],
  },

  'phone-service.approved': {
    parts: ['approved'],
    variables: [],
  },

  'phone-service.approved-once': {
    parts: ['approved once'],
    variables: [],
  },

  'phone-service.grant-target': {
    parts: ['', ' ', ''],
    variables: ['grant_kind', 'grant_target'],
  },

  'phone-service.turned-yolo-on-for': {
    parts: ['turned yolo on for'],
    variables: [],
  },

  'phone-service.turned-yolo-off-for': {
    parts: ['turned yolo off for'],
    variables: [],
  },

  'phone-service.grant-requests-are-now-approved-automatically': {
    parts: ['grant requests are now approved automatically'],
    variables: [],
  },

  'phone-service.grant-requests-now-ask-before-running': {
    parts: ['grant requests now ask before running'],
    variables: [],
  },

  'phone-service.a-member': {
    parts: ['A member'],
    variables: [],
  },

  'phone-service.connected': {
    parts: ['connected'],
    variables: [],
  },

  'phone-service.the-request-can-continue': {
    parts: ['The request can continue.'],
    variables: [],
  },



  'provider-webhooks.beeline': {
    parts: ['Beeline'],
    variables: [],
  },

  'provider-webhooks.received': {
    parts: ['received'],
    variables: [],
  },

  'provider-webhooks.a-linear-issue': {
    parts: ['a Linear issue'],
    variables: [],
  },

  'provider-webhooks.a-stripe-payment': {
    parts: ['a Stripe payment'],
    variables: [],
  },

  'repository-onboarding.suggested-work': {
    parts: ['suggested work'],
    variables: [],
  },

  'repository-onboarding.offered-a-repository': {
    parts: ['offered a repository'],
    variables: [],
  },

  'repository-onboarding.choose-or-create-a-repository': {
    parts: ['Choose or create a repository'],
    variables: [],
  },

  'repository-subscription-line.opened-issue': {
    parts: ['opened issue'],
    variables: [],
  },

  'repository-subscription-line.closed-issue': {
    parts: ['closed issue'],
    variables: [],
  },

  'repository-subscription-line.reopened-issue': {
    parts: ['reopened issue'],
    variables: [],
  },

  'repository-subscription-line.opened-pull-request': {
    parts: ['opened pull request'],
    variables: [],
  },

  'repository-subscription-line.merged-pull-request': {
    parts: ['merged pull request'],
    variables: [],
  },

  'repository-subscription-line.closed-pull-request': {
    parts: ['closed pull request'],
    variables: [],
  },

  'repository-subscription-line.reopened-pull-request': {
    parts: ['reopened pull request'],
    variables: [],
  },

  'repository-subscription-line.starred': {
    parts: ['starred'],
    variables: [],
  },

  'repository-subscription-line.unstarred': {
    parts: ['unstarred'],
    variables: [],
  },

  'repository-subscription-line.space': {
    parts: [' '],
    variables: [],
  },

  'repository-subscription-line.clipped-title': {
    parts: ['', '…'],
    variables: ['title_slice_0_79_trimEnd'],
  },

  'repository-subscription-line.item-number': {
    parts: ['#', ''],
    variables: ['details_number'],
  },

  'repository-subscription-line.github': {
    parts: ['GitHub'],
    variables: [],
  },

  'room-choice.asked': {
    parts: ['asked'],
    variables: [],
  },

  'room-choice.of-voted-for': {
    parts: ['', ' of ', ' voted for ', ''],
    variables: ['responses_length', 'choice_electorate_length', 'winner_label'],
  },

  'room-choice.asked-a-poll': {
    parts: ['asked a poll'],
    variables: [],
  },

  'room-choice.expired-no-answer': {
    parts: ['expired · no answer'],
    variables: [],
  },

  'room-choice.skipped': {
    parts: ['skipped · @', ''],
    variables: ['handleOf_viewer'],
  },

  'room-choice.skipped-2': {
    parts: ['skipped'],
    variables: [],
  },

  'room-choice.someone': {
    parts: ['someone'],
    variables: [],
  },

  'room-choice.picked': {
    parts: ['picked ', ' · @', ''],
    variables: ['option_letter', 'handleOf_viewer'],
  },

  'room-choice.picked-2': {
    parts: ['picked'],
    variables: [],
  },

  'subscription-webhooks.beeline': {
    parts: ['Beeline'],
    variables: [],
  },

  'subscription-webhooks.received': {
    parts: ['received'],
    variables: [],
  },

  'subscription-webhooks.a-webhook-call': {
    parts: ['a webhook call'],
    variables: [],
  },

  'system-line.space': {
    parts: [' '],
    variables: [],
  },

  'system-line.handle-word-separator': {
    parts: ['_'],
    variables: [],
  },

  'system-line.agent': {
    parts: ['agent'],
    variables: [],
  },

  'system-line.identity-mention': {
    parts: ['@', ''],
    variables: ['row_handle'],
  },

  'system-line.github': {
    parts: ['GitHub'],
    variables: [],
  },

  'system-line.beeline': {
    parts: ['Beeline'],
    variables: [],
  },

  'system-line.received': {
    parts: ['received'],
    variables: [],
  },

  'system-line.a-room-event': {
    parts: ['a Room event'],
    variables: [],
  },

  'unfinished-app-sign-ins.app-sign-in-timed-out-open-the-connection-card-and-sign-in-again': {
    parts: ['App sign-in timed out. Open the connection card and sign in again.'],
    variables: [],
  },

  'vault-save-http.saved-a-vault-entry': {
    parts: ['saved a vault entry'],
    variables: [],
  },

  'vault-save-http.entry-title': {
    parts: ['', ' / ', ''],
    variables: ['metadata_service', 'metadata_label'],
  },

  'vault-save-http.fields-hosts': {
    parts: ['', ' · fields: ', ' · hosts: ', ''],
    variables: [
      'result_reference',
      'metadata_fields_map_field_field',
      'result_allowedHosts_metadata_allowedHosts_join',
    ],
  },

  'vault-save-http.list-separator': {
    parts: [', '],
    variables: [],
  },
} as const;

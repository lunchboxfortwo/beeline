export const SYSTEM_MESSAGE_AWAY_AUTO_PAUSE = {

  'agent-command.agent-mention': {
    parts: ['@', ''],
    variables: ['target_handle'],
  },













  'agent-command.asked-for-a-new-key': {
    parts: ['asked for a new key'],
    variables: [],
  },

  'agent-command.started-a-sign-in': {
    parts: ['started a ', ' sign-in'],
    variables: ['AGENT_SIGN_IN_SERVICE_LABELS'],
  },

  'agent-command.its-owner-finishes-it-in-this-card': {
    parts: ['its owner finishes it in this card'],
    variables: [],
  },

  'agent-command.supports-lifecycle-commands': {
    parts: ['supports lifecycle commands'],
    variables: [],
  },

  'agent-command.restart-status-stop-retry-debug-help-login': {
    parts: ['restart · status · stop · retry · debug · help · /login'],
    variables: [],
  },

  'agent-command.is-online': {
    parts: ['is online'],
    variables: [],
  },

  'agent-command.is-offline': {
    parts: ['is offline'],
    variables: [],
  },

  'agent-command.one-turn-is-running': {
    parts: ['one turn is running'],
    variables: [],
  },

  'agent-command.no-turn-is-running': {
    parts: ['no turn is running'],
    variables: [],
  },

  'agent-command.lifecycle': {
    parts: ['lifecycle ', ''],
    variables: ['target_lifecycle_id_unknown'],
  },

  'agent-command.unknown': {
    parts: ['unknown'],
    variables: [],
  },

  'agent-command.release': {
    parts: ['release ', ''],
    variables: ['target_release_version_unknown'],
  },

  'agent-command.source': {
    parts: ['source ', ''],
    variables: ['target_source_sha_slice_0'],
  },

  'agent-command.turn': {
    parts: ['turn ', ''],
    variables: ['active_request_id'],
  },

  'agent-command.no-active-turn': {
    parts: ['no active turn'],
    variables: [],
  },

  'agent-command.reported-diagnostics': {
    parts: ['reported diagnostics'],
    variables: [],
  },

  'agent-command.separator': {
    parts: [' · '],
    variables: [],
  },



  'agent-command.stopped-its-running-turn': {
    parts: ['stopped its running turn'],
    variables: [],
  },

  'agent-command.queued-dropped': {
    parts: ['', ' queued ', ' dropped'],
    variables: ['dropped', 'dropped_1_order_orders'],
  },

  'agent-command.order': {
    parts: ['order'],
    variables: [],
  },

  'agent-command.orders': {
    parts: ['orders'],
    variables: [],
  },



  'agent-command.queued-a-retry-for-its-last-failed-turn': {
    parts: ['queued a retry for its last failed turn'],
    variables: [],
  },



  'agent-command.queued-a-restart': {
    parts: ['queued a restart'],
    variables: [],
  },

  'agent-command.running-turn-will-drain-first': {
    parts: ['running turn will drain first'],
    variables: [],
  },

  'agent-command.helper-will-reconnect-to-confirm': {
    parts: ['helper will reconnect to confirm'],
    variables: [],
  },

  'agent-command.found-merge-conflicts-in': {
    parts: ['found merge conflicts in'],
    variables: [],
  },

  'agent-sign-in.sign-in-failed-on-the-agent-machine': {
    parts: ['Sign-in failed on the agent machine.'],
    variables: [],
  },

  'agent-subscriptions.beeline': {
    parts: ['Beeline'],
    variables: [],
  },

  'agent-subscriptions.received': {
    parts: ['received'],
    variables: [],
  },

  'agent-subscriptions.a-slack-message': {
    parts: ['a Slack message'],
    variables: [],
  },

  'agent-subscriptions.channel-name': {
    parts: ['#', ''],
    variables: ['row_service_channel_name'],
  },

  'app-connections.app-sign-in-needs-attention': {
    parts: ['App sign-in needs attention'],
    variables: [],
  },

  'app-connections.app-sign-in-timed-out-open-the-connection-card-and-sign-in-again': {
    parts: ['App sign-in timed out. Open the connection card and sign in again.'],
    variables: [],
  },

  'app-connections.app-sign-in-is-unavailable': {
    parts: ['App sign-in is unavailable'],
    variables: [],
  },

  'app-connections.app-connection-could-not-be-checked-try-again': {
    parts: ['App connection could not be checked. Try again.'],
    variables: [],
  },

  'app-connections.the-mcp-connection-was-removed-reconnect-it': {
    parts: ['The MCP connection was removed; reconnect it'],
    variables: [],
  },

  'app-connections.connection-failed': {
    parts: ['Connection failed'],
    variables: [],
  },

  'app-connections.connect-trusty-squire-in-connectors-first': {
    parts: ['Connect Trusty Squire in Connectors first'],
    variables: [],
  },

  'app-connections.its-vault-key-needs-attention-in-trusty-squire': {
    parts: ['Its vault key needs attention in Trusty Squire'],
    variables: [],
  },

  'app-connections.app-sign-in-failed': {
    parts: ['App sign-in failed'],
    variables: [],
  },

  'commander.stopped': {
    parts: ['stopped'],
    variables: [],
  },

  'commander.s-running-turn': {
    parts: ['', "'s running turn"],
    variables: ['systemIdentityMention_worker_kind_agent'],
  },

  'commander.queued-dropped': {
    parts: ['', ' queued ', ' dropped'],
    variables: ['dropped', 'dropped_1_order_orders'],
  },

  'commander.order': {
    parts: ['order'],
    variables: [],
  },

  'commander.orders': {
    parts: ['orders'],
    variables: [],
  },

  'commander.ordered': {
    parts: ['ordered'],
    variables: [],
  },

  'commander.reported-to': {
    parts: ['reported to'],
    variables: [],
  },

  'computer-session.browser': {
    parts: ['Browser'],
    variables: [],
  },

  'computer-session.shared': {
    parts: ['shared'],
    variables: [],
  },

  'computer-session.a-live-browser': {
    parts: ['a live browser'],
    variables: [],
  },

  'connector-offer-completion.reconnected': {
    parts: ['reconnected'],
    variables: [],
  },

  'connector-offer-completion.added': {
    parts: ['added'],
    variables: [],
  },

  'connector-offer-completion.reconnected-automatically': {
    parts: ['reconnected automatically'],
    variables: [],
  },

  'corner-holds.set-a-merge-hold': {
    parts: ['set a merge hold'],
    variables: [],
  },

  'corner-holds.citation': {
    parts: ['', ': “', '”'],
    variables: ['citation_source_name', 'citation_source_text'],
  },

  'corner-lifecycle.no-reviewer-is-configured': {
    parts: ['no reviewer is configured'],
    variables: [],
  },

  'corner-lifecycle.blocked': {
    parts: ['blocked: ', ''],
    variables: ['reason'],
  },

  'corner-lifecycle.the-implementer-cannot-be-woken-to-arrange-review': {
    parts: ['The implementer cannot be woken to arrange review'],
    variables: [],
  },

  'corner-lifecycle.requested-review-of': {
    parts: ['requested review of'],
    variables: [],
  },

  'corner-lifecycle.unknown-dispatch-error': {
    parts: ['unknown dispatch error'],
    variables: [],
  },

  'corner-lifecycle.blocked-configured-reviewer-could-not-be-reached': {
    parts: ['blocked: configured reviewer ', ' could not be reached: ', ''],
    variables: ['input_reviewerName_input_reviewerId', 'input_reason'],
  },

  'corner-reviewer.set-the-corner-reviewer': {
    parts: ['set the corner reviewer'],
    variables: [],
  },

  'daemon-service.mcp-server': {
    parts: ['MCP server'],
    variables: [],
  },

  'daemon-service.wants-a-vault-entry': {
    parts: ['wants a vault entry'],
    variables: [],
  },

  'daemon-service.vault-entry-title': {
    parts: ['', ' / ', ''],
    variables: ['metadata_service', 'metadata_label'],
  },





  'daemon-service.connected': {
    parts: ['connected'],
    variables: [],
  },

  'daemon-service.the-requesting-agent-can-continue-the-original-task': {
    parts: ['the requesting agent can continue the original task'],
    variables: [],
  },

  'daemon-service.needs': {
    parts: ['needs'],
    variables: [],
  },

  'daemon-service.provider-sign-in': {
    parts: ['provider sign-in'],
    variables: [],
  },

  'daemon-service.the-provider-sign-in-page-is-ready-connect-this-tool-through-trus': {
    parts: ['the provider sign-in page is ready · connect this tool through Trusty Squire'],
    variables: [],
  },

  'daemon-service.tailscale-sign-in': {
    parts: ['Tailscale sign-in'],
    variables: [],
  },

  'daemon-service.click-the-link-to-join-this-machine-to-the-tailnet': {
    parts: ['click the link to join this machine to the tailnet'],
    variables: [],
  },

  'daemon-service.closed': {
    parts: ['closed'],
    variables: [],
  },

  'daemon-service.link-purchase-at': {
    parts: ['Link purchase at ', ''],
    variables: ['input_merchant'],
  },

  'daemon-service.usd': {
    parts: ['', ' USD · ', ''],
    variables: ['input_amount_100_toFixed_2', 'input_description'],
  },

  'daemon-service.link': {
    parts: ['Link'],
    variables: [],
  },

  'daemon-service.needs-your-approval-for': {
    parts: ['needs your approval for'],
    variables: [],
  },

  'daemon-service.trusty-squire': {
    parts: ['trusty-squire'],
    variables: [],
  },

  'daemon-service.the-request-to': {
    parts: ['The request to ', ''],
    variables: ['action'],
  },

  'daemon-service.expired': {
    parts: ['expired'],
    variables: [],
  },

  'daemon-service.was-allowed': {
    parts: ['was allowed'],
    variables: [],
  },

  'daemon-service.was-denied': {
    parts: ['was denied'],
    variables: [],
  },

  'daemon-service.google-sign-in': {
    parts: ['Google sign-in'],
    variables: [],
  },

  'daemon-service.asked-to': {
    parts: ['asked ', ' to'],
    variables: ['requester_handle_requester_handle'],
  },

  'daemon-service.requester-mention': {
    parts: ['@', ''],
    variables: ['requester_handle'],
  },

  'daemon-service.an-agent': {
    parts: ['An agent'],
    variables: [],
  },

  'daemon-service.emitted': {
    parts: ['emitted'],
    variables: [],
  },

  'daemon-service.proposed-a-target-branch': {
    parts: ['proposed a target branch'],
    variables: [],
  },

  'daemon-service.instead-of': {
    parts: ['instead of ', ''],
    variables: ['input_from'],
  },
} as const;

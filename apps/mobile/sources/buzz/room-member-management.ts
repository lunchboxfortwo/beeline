export function roomMemberManagementState({
  isDirectMessage,
  participantsHydrated,
  pickerRequested,
}: {
  isDirectMessage: boolean;
  participantsHydrated: boolean;
  pickerRequested: boolean;
}) {
  return {
    canOpenRoster: !isDirectMessage && participantsHydrated,
    pickerVisible: !isDirectMessage && pickerRequested,
  };
}

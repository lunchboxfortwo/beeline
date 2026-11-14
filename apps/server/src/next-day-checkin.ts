// Retire the unsolicited next-day wake and its private delivery state.
export const NEXT_DAY_CHECKIN_SCHEMA = `
DROP FUNCTION IF EXISTS note_checkin_first_message() CASCADE;
DROP FUNCTION IF EXISTS note_checkin_reply() CASCADE;
`;

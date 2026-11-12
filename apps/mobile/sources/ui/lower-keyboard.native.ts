import { Keyboard } from 'react-native';

/** Lower the phone keyboard, so a sheet that opens is not drawn under it. */
export const lowerKeyboard = () => Keyboard.dismiss();

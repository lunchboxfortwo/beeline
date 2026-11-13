import React from 'react';
import Animated, { Easing, FadeInDown, ReduceMotion } from 'react-native-reanimated';

/**
 * Onboarding's one motion (build spec → Grammar → Motion): a block rises in
 * over 380 ms, each later block 80 ms after the one before it, and nothing
 * moves when the system asks for reduced motion.
 */
export function Rise({ order = 0, children }: { order?: 0 | 1 | 2; children: React.ReactNode }) {
    const entering = FadeInDown.duration(380)
        .delay(order * 80)
        .easing(Easing.bezier(0.2, 0.7, 0.2, 1))
        .withInitialValues({ opacity: 0, transform: [{ translateY: 10 }] })
        .reduceMotion(ReduceMotion.System);
    return <Animated.View entering={entering}>{children}</Animated.View>;
}

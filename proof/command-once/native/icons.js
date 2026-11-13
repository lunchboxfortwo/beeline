import React from 'react';
import {Text} from 'react-native';
// Expo Go has an older SVG native module. Keep glyph footprints without that module.
const Icon=({size=16,color})=><Text style={{width:size,height:size,fontSize:size,color}}>›</Text>;
export const ArrowLeft=Icon, Check=Icon, ChevronRight=Icon, Copy=Icon, MessagesSquare=Icon, AtSign=Icon, ArrowRight=Icon, Bookmark=Icon, ChevronDown=Icon, ExternalLink=Icon, X=Icon;

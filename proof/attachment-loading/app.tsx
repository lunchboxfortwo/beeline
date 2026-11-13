import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { AttachmentCard } from '@proof/row';
import { buzz } from './theme';
const attachment = { url: '/v1/media/11111111-1111-4111-8111-111111111111', name: '29559.jpg', mimeType: 'image/jpeg', size: 606000 };
document.body.style.background = buzz.bgBase;
createRoot(document.getElementById('root')!).render(<View style={{ padding: 16, maxWidth: 720 }}>
  <Text style={{ ...buzz.type.body, color: buzz.textPrimary }}>@niglet what is this?</Text>
  <AttachmentCard attachment={attachment} isDesktop={innerWidth > 800} visible />
  <AttachmentCard attachment={{ ...attachment, name: 'deferred.jpg' }} isDesktop={false} visible={false} />
</View>);

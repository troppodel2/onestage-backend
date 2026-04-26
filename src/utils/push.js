const { Expo } = require('expo-server-sdk');
const expo = new Expo();

/**
 * Invia una push notification a un singolo token Expo.
 * Non lancia eccezioni — logga e ignora errori silenziosamente.
 */
async function sendPush(pushToken, { title, body, data = {} }) {
  if (!pushToken || !Expo.isExpoPushToken(pushToken)) return;

  const message = {
    to: pushToken,
    sound: 'default',
    title,
    body,
    data,
  };

  try {
    const chunks = expo.chunkPushNotifications([message]);
    for (const chunk of chunks) {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      receipts.forEach(r => {
        if (r.status === 'error') {
          console.error('Push error:', r.message, r.details);
        }
      });
    }
  } catch (e) {
    console.error('sendPush exception:', e.message);
  }
}

module.exports = { sendPush };

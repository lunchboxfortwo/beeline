import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Looper;
import android.os.Parcelable;
import java.util.Date;

/** Test-only FCM injection on a rooted emulator, using the installed APK's models. */
public final class AndroidPushReplay {
  public static void main(String[] args) throws Exception {
    Looper.prepareMainLooper();
    Class<?> activityThread = Class.forName("android.app.ActivityThread");
    Object thread = activityThread.getMethod("systemMain").invoke(null);
    Context system = (Context) activityThread.getMethod("getSystemContext").invoke(thread);
    Context app = system.createPackageContext(args[0], Context.CONTEXT_INCLUDE_CODE | Context.CONTEXT_IGNORE_SECURITY);
    ClassLoader loader = app.getClassLoader();
    Class<?> remoteType = loader.loadClass(args[1]);
    Class<?> contentType = loader.loadClass(args[2]);
    Class<?> triggerType = loader.loadClass(args[3]);
    Class<?> requestType = loader.loadClass(args[4]);
    Class<?> notificationType = loader.loadClass(args[5]);
    Class<?> contentInterface = loader.loadClass(args[6]);
    Class<?> triggerInterface = loader.loadClass(args[7]);
    Bundle fields = new Bundle();
    for (int i = 8; i < args.length; i++) {
      int equals = args[i].indexOf('=');
      fields.putString(args[i].substring(0, equals), args[i].substring(equals + 1));
    }
    Object remote = remoteType.getConstructor(Bundle.class).newInstance(fields);
    Object content = contentType.getConstructor(remoteType).newInstance(remote);
    Object trigger = triggerType.getConstructor(remoteType).newInstance(remote);
    Object request = requestType.getConstructor(String.class, contentInterface, triggerInterface)
      .newInstance(fields.getString("tag"), content, trigger);
    Parcelable notification = (Parcelable) notificationType.getConstructor(requestType, Date.class)
      .newInstance(request, new Date());
    // This is NotificationsService.receive's real broadcast, with a real native
    // RemoteNotificationContent. Expo constructs the shade PendingIntent; the
    // test taps it instead of manufacturing a JS NotificationResponse.
    Intent receive = new Intent("expo.modules.notifications.NOTIFICATION_EVENT");
    receive.setClassName(args[0], "expo.modules.notifications.service.NotificationsService");
    receive.putExtra("type", "receive");
    receive.putExtra("notification", notification);
    app.sendBroadcast(receive);
  }
}

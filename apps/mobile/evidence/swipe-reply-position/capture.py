import subprocess,time,pathlib,sys,signal,json,re
root=pathlib.Path('/tmp/swipe-reply-1')
phase=sys.argv[1]
adb=['/home/lunchbox/android-sdk/platform-tools/adb','-H','127.0.0.1','-P','5037','-s','emulator-5626']
def run(*args): return subprocess.run(adb+list(args),check=True,stdout=subprocess.PIPE).stdout
pid=run('shell','pidof','app.usebeeline.swipeproof').decode().strip()
with (root/f'{phase}-native.log').open('wb') as output:
 log=subprocess.Popen(adb+['logcat','--pid='+pid,'-T','1','-v','brief'],stdout=output,stderr=subprocess.STDOUT)
 def shot(name): (root/f'{phase}-{name}.png').write_bytes(run('exec-out','screencap','-p'))
 def capture(name,kind):
  run('shell','input','tap','160','260');time.sleep(1)

  if kind=='tail':
   run('shell','input','tap','500','260');time.sleep(1)
  shot(name+'-start')
  video=subprocess.Popen(adb+['shell','screenrecord','--time-limit','12',f'/sdcard/{phase}-{name}.mp4'],stdout=subprocess.DEVNULL)
  time.sleep(.5)
  if kind=='left':
   run('shell','input','swipe','800','1100','765','1100','800');time.sleep(.5);shot(name+'-short')
   run('shell','input','swipe','800','1100','200','1100','1000')
  elif kind=='right': run('shell','input','swipe','220','1100','800','1100','1000')
  else: run('shell','input','tap','340','260')
  time.sleep(2);shot(name+'-end')
  video.wait(timeout=15)
  run('pull',f'/sdcard/{phase}-{name}.mp4',str(root/f'{phase}-{name}.mp4'))

  if kind!='right': run('shell','input','keyevent','4');time.sleep(.8)
 if phase=='tail': capture('tail','tail')
 else: capture('swipe','left')
 if phase=='after':
  capture('tap','tap')
  capture('corner','right')
  capture('tail','tail')
 log.send_signal(signal.SIGINT);log.wait(timeout=5)
events=run('shell','run-as','app.usebeeline.swipeproof','cat','files/swipe-proof.json')
(root/f'{phase}-events.json').write_bytes(events)
print(json.dumps([x for x in json.loads(events) if x['phase']!='offset'],indent=2))

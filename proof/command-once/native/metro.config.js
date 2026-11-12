const {getDefaultConfig}=require('../../../apps/mobile/node_modules/expo/metro-config');
const path=require('path');
const config=getDefaultConfig(__dirname);
const mobile=path.resolve(__dirname,'../../../apps/mobile'),root=path.resolve(mobile,'../..');
config.watchFolders=[mobile,path.join(root,'packages'),path.join(root,'node_modules')];
config.resolver.nodeModulesPaths=[path.join(mobile,'node_modules'),path.join(root,'node_modules')];
config.resolver.unstable_enableSymlinks=true;
config.resolver.resolveRequest=(context,name,platform)=>{
if(name==='lucide-react-native')return {type:'sourceFile',filePath:path.join(__dirname,'icons.js')};
if(/react-native-reanimated|lower-keyboard$|RequestMedia$|\/IdentityMark$|\/Ledger$|^\.\/ErrorBanner$/.test(name))return {type:'sourceFile',filePath:path.join(__dirname,'stubs.js')};
if(name.startsWith('@/'))return context.resolveRequest(context,path.join(mobile,'sources',name.slice(2)),platform);
return context.resolveRequest(context,name,platform);
};
module.exports=config;

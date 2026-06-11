'use strict';

const store=new Map();
const internetStore=new Map();
const securityCalls=[];

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function internetKey(server, protocol, account) {
  return `${server}::${protocol}::${account}`;
}

function setInternetCredential({ server = 'facebook.com', protocol = 'htps', username, password }) {
  internetStore.set(internetKey(server, protocol, username), password);
}

function internetMetadata(server, protocol, account) {
  return [
    'keychain: "/Users/test/Library/Keychains/login.keychain-db"',
    'class: "inet"',
    'attributes:',
    `    "acct"<blob>="${account}"`,
    `    "srvr"<blob>="${server}"`,
    `    "ptcl"<uint32>="${protocol}"`
  ].join('\n');
}

function findInternetPassword(args) {
  const server = argValue(args, '-s');
  const protocol = argValue(args, '-r') || 'htps';
  const account = argValue(args, '-a');
  const wantsPassword = args.includes('-w');
  const foundKey = account
    ? internetKey(server, protocol, account)
    : [...internetStore.keys()].find(k => k.startsWith(`${server}::${protocol}::`));

  if (!foundKey || !internetStore.has(foundKey)) return Promise.reject(new Error('not found'));
  const username = foundKey.slice(`${server}::${protocol}::`.length);
  if (wantsPassword) return Promise.resolve({ stdout: `${internetStore.get(foundKey)}\n`, stderr: '' });
  return Promise.resolve({ stdout: `${internetMetadata(server, protocol, username)}\n`, stderr: '' });
}

function fakeRunner(args){
  securityCalls.push([...args]);
  const op=args[0],a=args[args.indexOf('-a')+1],s=args[args.indexOf('-s')+1],w=args.indexOf('-w'),k=`${s}::${a}`;
  if(op==='add-generic-password'){store.set(k,args[w+1]); return Promise.resolve({stdout:'',stderr:''});}
  if(op==='find-generic-password'){if(!store.has(k)) return Promise.reject(new Error('not found')); return Promise.resolve({stdout:args.includes('-w')?`${store.get(k)}\n`:'',stderr:''});}
  if(op==='delete-generic-password'){store.delete(k); return Promise.resolve({stdout:'',stderr:''});}
  if(op==='find-internet-password') return findInternetPassword(args);
  return Promise.reject(new Error(op));
}

module.exports={store,internetStore,securityCalls,fakeRunner,setInternetCredential};

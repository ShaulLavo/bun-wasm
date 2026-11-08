import { mount, StartClient } from '@solidjs/start/client';
const root = document.getElementById('app');
if (!root) throw new Error('App root missing');
mount(() => <StartClient />, root);

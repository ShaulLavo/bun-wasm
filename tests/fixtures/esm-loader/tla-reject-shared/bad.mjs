await new Promise(resolve => setTimeout(resolve, 1));
throw new Error('bad module');

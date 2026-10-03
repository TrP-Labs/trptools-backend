// A local S3 fixture for upload/remove flows; it never forwards to real storage.
const objects = new Map<string,{bytes:ArrayBuffer;contentType:string}>()
Bun.serve({hostname:'127.0.0.1',port:53900,async fetch(request){
    const path=new URL(request.url).pathname
    if(request.method==='PUT'){objects.set(path,{bytes:await request.arrayBuffer(),contentType:request.headers.get('content-type')??'application/octet-stream'});return new Response('',{status:200})}
    if(request.method==='DELETE'){objects.delete(path);return new Response(null,{status:204})}
    const object=objects.get(path)
    return object?new Response(object.bytes,{headers:{'content-type':object.contentType}}):new Response('Not Found',{status:404})
}})
console.log('Isolated S3 fixture on :53900')

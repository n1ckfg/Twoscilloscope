// Web Worker for skeleton tracing

var TraceSkeleton = new function(){ var that = this;

  function notEmpty(im, W, H, x, y, w, h){
    for (var i = y; i < y+h; i++){
      for (var j = x; j < x+w; j++){
        if (im[i*W+j]) return true;
      }
    }
    return false;
  }

  function mergeImpl(c0, c1, i, sx, isv, mode){
    var B0 = (mode >> 1 & 1)>0;
    var B1 = (mode >> 0 & 1)>0;
    var mj = -1;
    var md = 4;
    var l1 = c1[i].length-1;
    var p1 = c1[i][B1?0:l1];
    if (Math.abs(p1[isv?1:0]-sx)>0) return false;
    for (var j = 0; j < c0.length; j++){
      var l0 = c0[j].length-1;
      var p0 = c0[j][B0?0:l0];
      if (Math.abs(p0[isv?1:0]-sx)>1) continue;
      var d = Math.abs(p0[isv?0:1] - p1[isv?0:1]);
      if (d < md){ mj = j; md = d; }
    }
    if (mj != -1){
      if (B0 && B1){ c1[i].reverse(); c0[mj]=c1[i].concat(c0[mj]); }
      else if (!B0 && B1){ c0[mj]=c0[mj].concat(c1[i]); }
      else if (B0 && !B1){ c0[mj]=c1[i].concat(c0[mj]); }
      else { c1[i].reverse(); c0[mj]=c0[mj].concat(c1[i]); }
      c1.splice(i,1);
      return true;
    }
    return false;
  }

  var HORIZONTAL = 1;
  var VERTICAL = 2;

  function mergeFrags(c0, c1, sx, dr){
    for (var i = c1.length-1; i>=0; i--){
      if (dr == HORIZONTAL){
        if (mergeImpl(c0,c1,i,sx,false,1))continue;
        if (mergeImpl(c0,c1,i,sx,false,3))continue;
        if (mergeImpl(c0,c1,i,sx,false,0))continue;
        if (mergeImpl(c0,c1,i,sx,false,2))continue;
      }else{
        if (mergeImpl(c0,c1,i,sx,true,1))continue;
        if (mergeImpl(c0,c1,i,sx,true,3))continue;
        if (mergeImpl(c0,c1,i,sx,true,0))continue;
        if (mergeImpl(c0,c1,i,sx,true,2))continue;
      }
    }
    c1.map(x=>c0.push(x));
  }

  function chunkToFrags(im, W, H, x, y, w, h){
    var frags = [];
    var on = false;
    var li=-1, lj=-1;
    for (var k = 0; k < h+h+w+w-4; k++){
      var i, j;
      if (k < w){ i = y+0; j = x+k; }
      else if (k < w+h-1){ i = y+k-w+1; j = x+w-1; }
      else if (k < w+h+w-2){ i = y+h-1; j = x+w-(k-w-h+3); }
      else { i = y+h-(k-w-h-w+4); j = x+0; }
      if (im[i*W+j]){
        if (!on){
          on = true;
          frags.push([[j,i],[Math.floor(x+w/2),Math.floor(y+h/2)]])
        }
      }else{
        if (on){
          frags[frags.length-1][0][0] = Math.floor((frags[frags.length-1][0][0]+lj)/2);
          frags[frags.length-1][0][1] = Math.floor((frags[frags.length-1][0][1]+li)/2);
          on = false;
        }
      }
      li = i; lj = j;
    }
    if (frags.length == 2){
      frags = [[frags[0][0],frags[1][0]]]
    }else if (frags.length > 2){
      var ms = 0, mi = -1, mj = -1;
      for (var i = y+1; i < y+h-1; i++){
        for (var j = x+1; j < x+w-1; j++){
          var s = (im[i*W-W+j-1])+(im[i*W-W+j])+(im[i*W-W+j-1+1])+
                  (im[i*W+j-1])+(im[i*W+j])+(im[i*W+j+1])+
                  (im[i*W+W+j-1])+(im[i*W+W+j])+(im[i*W+W+j+1]);
          if (s > ms){ mi = i; mj = j; ms = s; }
          else if (s == ms && Math.abs(j-(x+w/2))+Math.abs(i-(y+h/2)) < Math.abs(mj-(x+w/2))+Math.abs(mi-(y+h/2))){
            mi = i; mj = j; ms = s;
          }
        }
      }
      if (mi != -1){
        for (var i = 0; i < frags.length; i++) frags[i][1]=[mj,mi];
      }
    }
    return frags;
  }

  that.traceSkeleton = function(im, W, H, x, y, w, h, csize, maxIter, rects){
    var frags = [];
    if (maxIter == 0) return frags;
    if (w <= csize && h <= csize) return chunkToFrags(im,W,H,x,y,w,h);

    var ms = W+H, mi = -1, mj = -1;

    if (h > csize){
      for (var i = y+3; i < y+h-3; i++){
        if (im[i*W+x]||im[(i-1)*W+x]||im[i*W+x+w-1]||im[(i-1)*W+x+w-1]) continue;
        var s = 0;
        for (var j = x; j < x+w; j++){ s += im[i*W+j]; s += im[(i-1)*W+j]; }
        if (s < ms){ ms = s; mi = i; }
        else if (s == ms && Math.abs(i-(y+h/2))<Math.abs(mi-(y+h/2))){ ms = s; mi = i; }
      }
    }

    if (w > csize){
      for (var j = x+3; j < x+w-3; j++){
        if (im[W*y+j]||im[W*(y+h)-W+j]||im[W*y+j-1]||im[W*(y+h)-W+j-1]) continue;
        var s = 0;
        for (var i = y; i < y+h; i++){ s += im[i*W+j]; s += im[i*W+j-1]; }
        if (s < ms){ ms = s; mi = -1; mj = j; }
        else if (s == ms && Math.abs(j-(x+w/2))<Math.abs(mj-(x+w/2))){ ms = s; mi = -1; mj = j; }
      }
    }

    if (h > csize && mi != -1){
      var L = [x,y,w,mi-y];
      var R = [x,mi,w,y+h-mi];
      if (notEmpty(im,W,H,L[0],L[1],L[2],L[3])){
        if(rects!=null)rects.push(L);
        frags = that.traceSkeleton(im,W,H,L[0],L[1],L[2],L[3],csize,maxIter-1,rects);
      }
      if (notEmpty(im,W,H,R[0],R[1],R[2],R[3])){
        if(rects!=null)rects.push(R);
        mergeFrags(frags,that.traceSkeleton(im,W,H,R[0],R[1],R[2],R[3],csize,maxIter-1,rects),mi,VERTICAL);
      }
    }else if (w > csize && mj != -1){
      var L = [x,y,mj-x,h];
      var R = [mj,y,x+w-mj,h];
      if (notEmpty(im,W,H,L[0],L[1],L[2],L[3])){
        if(rects!=null)rects.push(L);
        frags = that.traceSkeleton(im,W,H,L[0],L[1],L[2],L[3],csize,maxIter-1,rects);
      }
      if (notEmpty(im,W,H,R[0],R[1],R[2],R[3])){
        if(rects!=null)rects.push(R);
        mergeFrags(frags,that.traceSkeleton(im,W,H,R[0],R[1],R[2],R[3],csize,maxIter-1,rects),mj,HORIZONTAL);
      }
    }
    if (mi == -1 && mj == -1) frags = chunkToFrags(im,W,H,x,y,w,h);
    return frags;
  }
}

self.onmessage = function(e) {
  const { binaryImg, width, height } = e.data;
  const polylines = TraceSkeleton.traceSkeleton(binaryImg, width, height, 0, 0, width, height, 10, 999, null);
  self.postMessage({ polylines });
};

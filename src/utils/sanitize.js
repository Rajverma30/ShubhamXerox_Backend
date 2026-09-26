const xss = require('xss');

/** Allow-list HTML for rich-text description fields coming from the admin editor. */
const richTextOptions = {
  whiteList: {
    p: ['style'], br: [], b: [], strong: [], i: [], em: [], u: [], s: [],
    h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
    ul: [], ol: [], li: [], blockquote: [], code: [], pre: [], hr: [],
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    table: [], thead: [], tbody: [], tr: [], th: [], td: [],
    span: ['style'], div: ['style'],
  },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style', 'iframe'],
};

exports.cleanRichText = (html = '') => xss(String(html), richTextOptions);
exports.cleanText = (str = '') => xss(String(str), { whiteList: {}, stripIgnoreTag: true }).trim();

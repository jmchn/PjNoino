// make id attributes visible and clickable on a web page
var elems = document.getElementsByTagName("*");
for (let i = elems.length - 1; i >= 0; i--) {
    let elem = elems[i];
    if (elem.id) {
        console.log(elem.id)
        newlink = document.createElement('a');
        href = '#' + elem.id
        newlink.setAttribute('href', href);
        newlink.innerHTML = href
        elem.prepend(newlink);
    }
}

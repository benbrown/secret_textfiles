const parseUsers  = (string) => {
    if (!string) {
        string = '';
    }

    var creds = string.split(/\s+/);

    var users = {};
    creds.forEach(function(u) {
        var bits = u.split(/\:/);
        users[bits[0]] = bits[1];
    });

    return users;
}

module.exports = parseUsers;
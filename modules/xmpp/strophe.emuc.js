/* jshint -W117 */
/* a simple MUC connection plugin
 * can only handle a single MUC room
 */
var XMPPEvents = require("../../service/xmpp/XMPPEvents");
var Moderator = require("./moderator");
var JingleSession = require("./JingleSession");

var bridgeIsDown = false;

module.exports = function(XMPP, eventEmitter) {
    Strophe.addConnectionPlugin('emuc', {
        connection: null,
        roomjid: null,
        myroomjid: null,
        members: {},
        list_members: [], // so we can elect a new focus
        presMap: {},
        preziMap: {},
        joined: false,
        isOwner: false,
        role: null,
        focusMucJid: null,
        ssrc2jid: {},
        init: function (conn) {
            this.connection = conn;
        },
        initPresenceMap: function (myroomjid) {
            this.presMap['to'] = myroomjid;
            this.presMap['xns'] = 'http://jabber.org/protocol/muc';
        },
        doJoin: function (jid, password) {
            this.myroomjid = jid;

            console.info("Joined MUC as " + this.myroomjid);

            this.initPresenceMap(this.myroomjid);

            if (!this.roomjid) {
                this.roomjid = Strophe.getBareJidFromJid(jid);
                // add handlers (just once)
                this.connection.addHandler(this.onPresence.bind(this), null, 'presence', null, null, this.roomjid, {matchBare: true});
                this.connection.addHandler(this.onPresenceUnavailable.bind(this), null, 'presence', 'unavailable', null, this.roomjid, {matchBare: true});
                this.connection.addHandler(this.onPresenceError.bind(this), null, 'presence', 'error', null, this.roomjid, {matchBare: true});
                this.connection.addHandler(this.onMessage.bind(this), null, 'message', null, null, this.roomjid, {matchBare: true});
            }
            if (password !== undefined) {
                this.presMap['password'] = password;
            }
            this.sendPresence();
        },
        doLeave: function () {
            console.log("do leave", this.myroomjid);
            var pres = $pres({to: this.myroomjid, type: 'unavailable' });
            this.presMap.length = 0;
            this.connection.send(pres);
        },
        createNonAnonymousRoom: function () {
            // http://xmpp.org/extensions/xep-0045.html#createroom-reserved

            var getForm = $iq({type: 'get', to: this.roomjid})
                .c('query', {xmlns: 'http://jabber.org/protocol/muc#owner'})
                .c('x', {xmlns: 'jabber:x:data', type: 'submit'});

            var self = this;

            this.connection.sendIQ(getForm, function (form) {

                if (!$(form).find(
                        '>query>x[xmlns="jabber:x:data"]' +
                        '>field[var="muc#roomconfig_whois"]').length) {

                    console.error('non-anonymous rooms not supported');
                    return;
                }

                var formSubmit = $iq({to: this.roomjid, type: 'set'})
                    .c('query', {xmlns: 'http://jabber.org/protocol/muc#owner'});

                formSubmit.c('x', {xmlns: 'jabber:x:data', type: 'submit'});

                formSubmit.c('field', {'var': 'FORM_TYPE'})
                    .c('value')
                    .t('http://jabber.org/protocol/muc#roomconfig').up().up();

                formSubmit.c('field', {'var': 'muc#roomconfig_whois'})
                    .c('value').t('anyone').up().up();

                self.connection.sendIQ(formSubmit);

            }, function (error) {
                console.error("Error getting room configuration form");
            });
        },
        onPresence: function (pres) {
            var from = pres.getAttribute('from');

            // What is this for? A workaround for something?
            if (pres.getAttribute('type')) {
                return true;
            }

            // Parse etherpad tag.
            var etherpad = $(pres).find('>etherpad');
            if (etherpad.length) {
                if (config.etherpad_base && !Moderator.isModerator()) {
                    eventEmitter.emit(XMPPEvents.ETHERPAD, etherpad.text());
                }
            }

            // Parse prezi tag.
            var presentation = $(pres).find('>prezi');
            if (presentation.length) {
                var url = presentation.attr('url');
                var current = presentation.find('>current').text();

                console.log('presentation info received from', from, url);

                if (this.preziMap[from] == null) {
                    this.preziMap[from] = url;

                    $(document).trigger('presentationadded.muc', [from, url, current]);
                }
                else {
                    $(document).trigger('gotoslide.muc', [from, url, current]);
                }
            }
            else if (this.preziMap[from] != null) {
                var url = this.preziMap[from];
                delete this.preziMap[from];
                $(document).trigger('presentationremoved.muc', [from, url]);
            }

            // Parse audio info tag.
            var audioMuted = $(pres).find('>audiomuted');
            if (audioMuted.length) {
                $(document).trigger('audiomuted.muc', [from, audioMuted.text()]);
            }

            // Parse video info tag.
            var videoMuted = $(pres).find('>videomuted');
            if (videoMuted.length) {
                $(document).trigger('videomuted.muc', [from, videoMuted.text()]);
            }

            var stats = $(pres).find('>stats');
            if (stats.length) {
                var statsObj = {};
                Strophe.forEachChild(stats[0], "stat", function (el) {
                    statsObj[el.getAttribute("name")] = el.getAttribute("value");
                });
                eventEmitter.emit(XMPPEvents.REMOTE_STATS, from, statsObj);
            }

            // Parse status.
            if ($(pres).find('>x[xmlns="http://jabber.org/protocol/muc#user"]>status[code="201"]').length) {
                this.isOwner = true;
                this.createNonAnonymousRoom();
            }

            // Parse roles.
            var member = {};
            member.show = $(pres).find('>show').text();
            member.status = $(pres).find('>status').text();
            var tmp = $(pres).find('>x[xmlns="http://jabber.org/protocol/muc#user"]>item');
            member.affiliation = tmp.attr('affiliation');
            member.role = tmp.attr('role');

            // Focus recognition
            member.jid = tmp.attr('jid');
            member.isFocus = false;
            if (member.jid
                && member.jid.indexOf(Moderator.getFocusUserJid() + "/") == 0) {
                member.isFocus = true;
            }

            var nicktag = $(pres).find('>nick[xmlns="http://jabber.org/protocol/nick"]');
            member.displayName = (nicktag.length > 0 ? nicktag.html() : null);

            if (from == this.myroomjid) {
                if (member.affiliation == 'owner') this.isOwner = true;
                if (this.role !== member.role) {
                    this.role = member.role;
                    // Andrea Magatti 
                    // here we come when a direct election to moderator !
                    // devo lanciare un nuovo evento, che faccia aprire la lista
                    // degli utenti al nuovo moderatore
                    eventEmitter.emit(XMPPEvents.GRANTED_MODERATION, 
                        from, member.jid, member.displayName, member.role, pres, Moderator.isModerator());

                    eventEmitter.emit(XMPPEvents.LOCALROLE_CHANGED,
                        from, member, pres, Moderator.isModerator(),
                        Moderator.isExternalAuthEnabled());
                }
                if (!this.joined) {
                    this.joined = true;
                    eventEmitter.emit(XMPPEvents.MUC_JOINED, from, member);
                    this.list_members.push(from);
                }
            } else if (this.members[from] === undefined) {
                // new participant
                this.members[from] = member;
                this.list_members.push(from);
                console.log('entered', from, member);
                if (member.isFocus) {
                    this.focusMucJid = from;
                    console.info("Ignore focus: " + from + ", real JID: " + member.jid);
                }
                else {
                    var id = $(pres).find('>userID').text();
                    var email = $(pres).find('>email');
                    if (email.length > 0) {
                        id = email.text();
                    }
                    
                    eventEmitter.emit(XMPPEvents.MUC_ENTER, from, id, member.displayName);
                }
            } else {
                // Presence update for existing participant
                // Watch role change:
                if (this.members[from].role != member.role) {
                    this.members[from].role = member.role;
                    eventEmitter.emit(XMPPEvents.MUC_ROLE_CHANGED,
                        member.role, member.displayName);
                }
            }

            // Always trigger presence to update bindings
            this.parsePresence(from, member, pres);
            

            // Trigger status message update
            if (member.status) {
                eventEmitter.emit(XMPPEvents.PRESENCE_STATUS, from, member);
            }

            return true;
        },
        onPresenceUnavailable: function (pres) {
            var from = pres.getAttribute('from');
            // room destroyed ?
            if ($(pres).find('>x[xmlns="http://jabber.org/protocol/muc#user"]' +
                             '>destroy').length) {
                var reason;
                var reasonSelect = $(pres).find(
                    '>x[xmlns="http://jabber.org/protocol/muc#user"]' +
                    '>destroy>reason');
                if (reasonSelect.length) {
                    reason = reasonSelect.text();
                }
                
                XMPP.disposeConference(false);
                eventEmitter.emit(XMPPEvents.MUC_DESTROYED, reason);
                return true;
            }
            // Status code 110 indicates that this notification is "self-presence".
            if (!$(pres).find('>x[xmlns="http://jabber.org/protocol/muc#user"]>status[code="110"]').length) {
                delete this.members[from];
                this.list_members.splice(this.list_members.indexOf(from), 1);
                this.onParticipantLeft(from);
            }
            // If the status code is 110 this means we're leaving and we would like
            // to remove everyone else from our view, so we trigger the event.
            else if (this.list_members.length > 1) {
                for (var i = 0; i < this.list_members.length; i++) {
                    var member = this.list_members[i];
                    delete this.members[i];
                    this.list_members.splice(i, 1);
                    this.onParticipantLeft(member);
                }
            }
            if ($(pres).find('>x[xmlns="http://jabber.org/protocol/muc#user"]>status[code="307"]').length) {
                $(document).trigger('kicked.muc', [from]);
                if (this.myroomjid === from) {
                    reason = pres.lastChild.textContent;
                    XMPP.disposeConference(false);
                    eventEmitter.emit(XMPPEvents.KICKED, reason);
                }
            }
            
            if ($(pres).find('>x[xmlns="http://jabber.org/protocol/muc#user"]>status[code="301"]').length) {
                $(document).trigger('banned.muc', [from]);
                if (this.myroomjid === from) {
                    XMPP.disposeConference(false);
                    eventEmitter.emit(XMPPEvents.BANNED);
                }
            }
            return true;
        },
        onPresenceError: function (pres) {
            var from = pres.getAttribute('from');
            if ($(pres).find('>error[type="auth"]>not-authorized[xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"]').length) {
                console.log('on password required', from);
                var self = this;
                eventEmitter.emit(XMPPEvents.PASSWORD_REQUIRED, function (value) {
                    self.doJoin(from, value);
                });
            } else if ($(pres).find(
                '>error[type="cancel"]>not-allowed[xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"]').length) {
                var toDomain = Strophe.getDomainFromJid(pres.getAttribute('to'));
                if (toDomain === config.hosts.anonymousdomain) {
                    // enter the room by replying with 'not-authorized'. This would
                    // result in reconnection from authorized domain.
                    // We're either missing Jicofo/Prosody config for anonymous
                    // domains or something is wrong.
//                    XMPP.promptLogin();
                    APP.UI.messageHandler.openReportDialog(null,
                        'Oops ! We couldn`t join the conference.' +
                        ' There might be some problem with security' +
                        ' configuration. Please contact service' +
                        ' administrator.', pres);
                } else {
                    console.warn('onPresError ', pres);
                    APP.UI.messageHandler.openReportDialog(null,
                        'Oops! Something went wrong and we couldn`t connect to the conference.',
                        pres);
                }
            } else {
                console.warn('onPresError ', pres);
                APP.UI.messageHandler.openReportDialog(null,
                    "Sorry you can't join the room. Maybe you are banned, or this room is members only. Try again later",
                    pres);
            }
            return true;
        },
        sendMessage: function (body, nickname) {
            var msg = $msg({to: this.roomjid, type: 'groupchat'});
            msg.c('body', body).up();
            if (nickname) {
                msg.c('nick', {xmlns: 'http://jabber.org/protocol/nick'}).t(nickname).up().up();
            }
                       
            this.connection.send(msg);
            eventEmitter.emit(XMPPEvents.SENDING_CHAT_MESSAGE, body);
        },

        sendDirectRequest: function(body, from, recipient, kind){
            var msg = $msg({from: from, to: recipient, type: 'chat', kind: kind});
            msg.c('body', body).up();
            this.connection.send(msg);
        },

        sendHiddenDirectMessage: function(body, from, recipient, kind, action){
            var msg = $msg({from: from, to: recipient, type: 'chat', kind: kind, action: action});
            msg.c('body', body).up();
            this.connection.send(msg);    
        },

        sendTipMessage: function (body, nickname, amount, balance, notify) {
            
            // try to send a custom value in the message
            // Andrea Magatti 28-04-2015
            var msg = $msg({to: this.roomjid, type: 'groupchat', balance: balance, amount: amount, notify: notify});
            msg.c('body', body).up();
            if (nickname) {
                msg.c('nick', {xmlns: 'http://jabber.org/protocol/nick'}).t(nickname).up().up();
            }
                       
            this.connection.send(msg);
            eventEmitter.emit(XMPPEvents.SENDING_CHAT_MESSAGE, body);

        },
        sendPrivateShowMessage: function (body, nickname, rate, balance_limit, spy_rate) {
            // values for private show in the message
            // Andrea Magatti 20-05-2015
            var msg = $msg({to: this.roomjid, type: 'groupchat', rate: rate, balance_limit: balance_limit, spy_rate: spy_rate});
            msg.c('body', body).up();
            if (nickname) {
                msg.c('nick', {xmlns: 'http://jabber.org/protocol/nick'}).t(nickname).up().up();
            }
                       
            this.connection.send(msg);
            eventEmitter.emit(XMPPEvents.SENDING_CHAT_MESSAGE, body);
        },
        sendTicketShowMessage: function (body, nickname, min_n_users, group_token_per_min, full_ticket_price) {
            // values for ticket show
            // Andrea Magatti 20-05-2015
            var msg = $msg({to: this.roomjid, type: 'groupchat', min_n_users: min_n_users, group_token_per_min: group_token_per_min, full_ticket_price: full_ticket_price});
            msg.c('body', body).up();
            if (nickname) {
                msg.c('nick', {xmlns: 'http://jabber.org/protocol/nick'}).t(nickname).up().up();
            }
                       
            this.connection.send(msg);
            eventEmitter.emit(XMPPEvents.SENDING_CHAT_MESSAGE, body);
        },
        sendTicketShowStarting: function(body, nickname, price){
            // values to let the user konw how much will costo the ticket
            // Andrea Magatti 27-05-2015
            var msg = $msg({to: this.roomjid, type: 'groupchat', price: price});
            msg.c('body', body).up();
            if (nickname) {
                msg.c('nick', {xmlns: 'http://jabber.org/protocol/nick'}).t(nickname).up().up();
            }
                       
            this.connection.send(msg);
            eventEmitter.emit(XMPPEvents.SENDING_CHAT_MESSAGE, body);
        },



        setSubject: function (subject) {
            var msg = $msg({to: this.roomjid, type: 'groupchat'});
            msg.c('subject', subject);
            this.connection.send(msg);
            console.log("topic changed to " + subject);
        },
        onMessage: function (msg) {
            // FIXME: this is a hack. but jingle on muc makes nickchanges hard
            var from = msg.getAttribute('from');
            var nick =
                $(msg).find('>nick[xmlns="http://jabber.org/protocol/nick"]')
                    .text() ||
                Strophe.getResourceFromJid(from);

            var txt = $(msg).find('>body').text();
            var type = msg.getAttribute("type");
            var kind = msg.getAttribute('kind');
            var action = msg.getAttribute('action');
            var result = msg.getAttribute('result');
            var price = msg.getAttribute('price');

            if (type == "error") {
                eventEmitter.emit(XMPPEvents.CHAT_ERROR_RECEIVED,
                    $(msg).find('>text').text(), txt);
                return true;
            }


            var subject = $(msg).find('>subject');
            if (subject.length) {
                var subjectText = subject.text();
                if (subjectText || subjectText == "") {
                    eventEmitter.emit(XMPPEvents.SUBJECT_CHANGED, subjectText);
                    console.log("Subject is changed to " + subjectText);
                }
            }

            // need to check txt to get if a tip message is sent
            // and theb: eventEmitter.emit(XMPPEvents.TIP_GIVEN, USER, item_price );
            if (txt) {
                
                var amount = msg.getAttribute('amount');
                var balance = msg.getAttribute('balance');

                var private_token_per_min =msg.getAttribute('rate');
                var private_spy_per_min = msg.getAttribute('spy_rate');
                var min_balance_private = msg.getAttribute('balance_limit');

                var min_n_users = msg.getAttribute('min_n_users');
                var group_token_per_min = msg.getAttribute('group_token_per_min');
                var full_ticket_price = msg.getAttribute('full_ticket_price');

                var notify = msg.getAttribute('notify');

                // event to capture the tipping action sent via message
                if (balance != null || amount != null) {
                    eventEmitter.emit(XMPPEvents.TIP_GIVEN,
                        from, nick, amount, balance);
                    console.log('chat', nick, txt);
                    // dont' need to send chat message in private or spy rooms
                    if (notify == "true"){
                        eventEmitter.emit(XMPPEvents.MESSAGE_RECEIVED,
                            from, nick, txt, this.myroomjid, type);
                    }
                }
                // event to capture the availability of the performer for a private show
                else if (private_spy_per_min != null || private_token_per_min != null || min_balance_private != null){
                    eventEmitter.emit(XMPPEvents.PRIVATE_AVAILABILITY,
                        from, nick, private_token_per_min, private_spy_per_min, min_balance_private);
                    console.log('chat', nick, txt);
                    eventEmitter.emit(XMPPEvents.MESSAGE_RECEIVED,
                        from, nick, txt, this.myroomjid, type);   
                }
                // event to capture the availability of the performer for a ticket show
                else if (min_n_users != null || group_token_per_min != null || full_ticket_price != null){
                    eventEmitter.emit(XMPPEvents.TICKET_AVAILABILITY,
                        from, nick, min_n_users, group_token_per_min, full_ticket_price);
                    console.log('chat', nick, txt);
                    eventEmitter.emit(XMPPEvents.MESSAGE_RECEIVED,
                        from, nick, txt, this.myroomjid, type);   
                }
                else if (type =='chat' && kind == 'private'){
                    // this handles direct messages
                    eventEmitter.emit(XMPPEvents.PRIVATE_SHOW_REQUEST_RECEIVED, from, txt);
                    console.log('chat', nick, txt);
                    
                    eventEmitter.emit(XMPPEvents.MESSAGE_RECEIVED,
                        from, nick, txt, this.myroomjid, type);
                }
                else if (type =='chat' && kind == 'ticket'){
                    // this handles direct messages
                    eventEmitter.emit(XMPPEvents.TICKET_SHOW_REQUEST_RECEIVED, from, txt, result);
                    console.log('chat', nick, txt);
                    eventEmitter.emit(XMPPEvents.MESSAGE_RECEIVED,
                        from, nick, txt, this.myroomjid, type);
                }
                else if (type =='chat' && kind == 'hidden'){
                    if (action=="user_choose_video_sharing"){
                        eventEmitter.emit(XMPPEvents.PRIVATE_SHOW_STARTING, from, txt, action);
                        console.log('chat', nick, txt);
                    }
                    else if (action='user_in spy_mode'){
                        eventEmitter.emit(XMPPEvents.SPY_SHOW_STARTING, from, txt, action);
                        console.log('chat', nick, txt);
                    }    
                }
                else if (type='groupchat' && price != null){
                    eventEmitter.emit(XMPPEvents.TICKET_SHOW_STARTING, from, txt, price);
                    console.log('chat', nick, txt);
                } 
                else {
                    console.log('chat', nick, txt);
                    eventEmitter.emit(XMPPEvents.MESSAGE_RECEIVED,
                        from, nick, txt, this.myroomjid, type);
                }
            }
            return true;
        },
        lockRoom: function (key, onSuccess, onError, onNotSupported) {
            //http://xmpp.org/extensions/xep-0045.html#roomconfig
            var ob = this;
            this.connection.sendIQ($iq({to: this.roomjid, type: 'get'}).c('query', {xmlns: 'http://jabber.org/protocol/muc#owner'}),
                function (res) {
                    if ($(res).find('>query>x[xmlns="jabber:x:data"]>field[var="muc#roomconfig_roomsecret"]').length) {
                        var formsubmit = $iq({to: ob.roomjid, type: 'set'}).c('query', {xmlns: 'http://jabber.org/protocol/muc#owner'});
                        formsubmit.c('x', {xmlns: 'jabber:x:data', type: 'submit'});
                        formsubmit.c('field', {'var': 'FORM_TYPE'}).c('value').t('http://jabber.org/protocol/muc#roomconfig').up().up();
                        formsubmit.c('field', {'var': 'muc#roomconfig_roomsecret'}).c('value').t(key).up().up();
                        // Fixes a bug in prosody 0.9.+ https://code.google.com/p/lxmppd/issues/detail?id=373
                        formsubmit.c('field', {'var': 'muc#roomconfig_whois'}).c('value').t('anyone').up().up();
                        // FIXME: is muc#roomconfig_passwordprotectedroom required?
                        ob.connection.sendIQ(formsubmit,
                            onSuccess,
                            onError);
                    } else {
                        onNotSupported();
                    }
                }, onError);
        },
        
        makeRoomMembersOnly: function(onSuccess, onError, onNotSupported){
            //http://xmpp.org/extensions/xep-0045.html#roomconfig
            var ob = this;
            this.connection.sendIQ($iq({to: ob.roomjid, type: 'get'}).c('query', {xmlns: 'http://jabber.org/protocol/muc#owner'}),
                function (res){
                    if ($(res).find('>query>x[xmlns="jabber:x:data"]>field[var="muc#roomconfig_membersonly"]').length){
                        var formsubmit = $iq({to: ob.roomjid, type: 'set'}).c('query', {xmlns: 'http://jabber.org/protocol/muc#owner'});
                        formsubmit.c('x', {xmlns: 'jabber:x:data', type: 'submit'});
                        formsubmit.c('field', {'var': 'FORM_TYPE'}).c('value').t('http://jabber.org/protocol/muc#roomconfig').up().up();
                        formsubmit.c('field', {'var': "muc#roomconfig_membersonly"}).c('value').t(1).up().up();
                        // Fixes a bug in prosody 0.9.+ https://code.google.com/p/lxmppd/issues/detail?id=373
                        formsubmit.c('field', {'var': 'muc#roomconfig_whois'}).c('value').t('anyone').up().up();
                        ob.connection.sendIQ(formsubmit,
                            onSuccess,
                            onError);
                    } else {
                        onNotSupported();
                    }
                }, onError);
        },

        makeRoomNotMembersOnly: function(onSuccess, onError, onNotSupported){
            //http://xmpp.org/extensions/xep-0045.html#roomconfig
            var ob = this;
            this.connection.sendIQ($iq({to: ob.roomjid, type: 'get'}).c('query', {xmlns: 'http://jabber.org/protocol/muc#owner'}),
                function (res){
                    if ($(res).find('>query>x[xmlns="jabber:x:data"]>field[var="muc#roomconfig_membersonly"]').length){
                        var formsubmit = $iq({to: ob.roomjid, type: 'set'}).c('query', {xmlns: 'http://jabber.org/protocol/muc#owner'});
                        formsubmit.c('x', {xmlns: 'jabber:x:data', type: 'submit'});
                        formsubmit.c('field', {'var': 'FORM_TYPE'}).c('value').t('http://jabber.org/protocol/muc#roomconfig').up().up();
                        formsubmit.c('field', {'var': "muc#roomconfig_membersonly"}).c('value').t(0).up().up();
                        // Fixes a bug in prosody 0.9.+ https://code.google.com/p/lxmppd/issues/detail?id=373
                        formsubmit.c('field', {'var': 'muc#roomconfig_whois'}).c('value').t('anyone').up().up();
                        ob.connection.sendIQ(formsubmit,
                            onSuccess,
                            onError);
                    } else {
                        onNotSupported();
                    }
                }, onError);
        },

        revokeMembership: function(jid){
            myjid = PERFORMER_ID + "@" + config.hosts.domain;
            var revokeMembershipIQ = $iq({to: this.roomjid, type: 'set', id: 'revokeM'})
                .c('query', {xmlns: 'http://jabber.org/protocol/muc#admin'})
                .c('item', {jid: myjid, affiliation: 'none'})
                .c('reason').t('You are not anymore member of this room').up().up().up();
            this.connection.sendIQ(
                revokeMembershipIQ,
                function (result) {
                    console.log('Revoked membership to jid: ', jid, result);
                },
                function (error) {
                    console.log('Error revoking membership to: ', jid, error);
                });    
        },

        kick: function (jid, reason) {
            var kickIQ = $iq({to: this.roomjid, type: 'set'})
                .c('query', {xmlns: 'http://jabber.org/protocol/muc#admin'})
                .c('item', {nick: Strophe.getResourceFromJid(jid), role: 'none'})
                .c('reason').t(reason).up().up().up();

            this.connection.sendIQ(
                kickIQ,
                function (result) {
                    console.log('Kick participant with jid: ', jid, result);
                },
                function (error) {
                    console.log('Kick participant error: ', jid, error);
                });
        },
        ban: function (jid){
            var myjid = Strophe.getResourceFromJid(jid) + "@" + config.hosts.domain;
            // build the IQ string for banning the jid
            var banIQ = $iq({to: this.roomjid, type: 'set', id: 'ban1'})
                .c('query', {xmlns: 'http://jabber.org/protocol/muc#admin'})
                .c('item', {jid: myjid, affiliation: 'outcast'})
                .c('reason').t('You have been banned from this room').up().up().up();

            // adding user to outcast
            this.connection.sendIQ(
                banIQ,
                function (result) {
                    console.log('Banned participant with jid: ', jid, result);
                },
                function (error) {
                    console.log('Ban participant error: ', error);
                });

            //need to handle the jid provided to ensure that bare JIDs is passed to jabber server
            var kickIQ = $iq({to: this.roomjid, type: 'set'})
                .c('query', {xmlns: 'http://jabber.org/protocol/muc#admin'})
                .c('item', {nick: Strophe.getResourceFromJid(jid), role: 'none'})
                .c('reason').t('You have been kicked.').up().up().up();

            // now kicking out the user 
            this.connection.sendIQ(
                kickIQ,
                function (result) {
                    console.log('Kick participant with jid: ', jid, result);
                },
                function (error) {
                    console.log('Kick participant error: ', error);
                });        
        },

        grantModeration: function (jid){
            var grantIQ = $iq({to: this.roomjid, type: 'set', id: "grantModeration"})
                .c('query', {xmlns: 'http://jabber.org/protocol/muc#admin'})
                .c('item', {nick: Strophe.getResourceFromJid(jid), role: 'moderator'})
                .c('reason').t('Nice! You now are a Moderator').up().up().up();

            this.connection.sendIQ(
                grantIQ,
                function (result) {
                    console.log('Granting Moderator Status participant with jid: ', jid, result);
                },
                function (error) {
                    console.log(' No granting moderator Status to participant. Error: ', error);
                });

            var ownerIQ = $iq({to: this.roomjid, type: 'set', id: "grantOwnership"})
                .c('query', {xmlns: 'http://jabber.org/protocol/muc#admin'})
                .c('item', {nick: Strophe.getResourceFromJid(jid), affiliation: 'owner'})
                .c('reason').t('Nice! You are now an Owner').up().up().up();

            this.connection.sendIQ(
                ownerIQ,
                function (result) {
                    console.log('Granting Owner Status participant with jid: ', jid, result);
                },
                function (error) {
                    console.log(' Not granting ownership to participant. Error: ', error);
                });    

        },

        // destroy jabber room when performer exit the show
        destroyRoom: function () {
             
             var reason_by_role = 'Any participant has been notified. See you soon!'
             var destroyIQ = $iq({to: this.roomjid, type: 'set'})
                .c('query', {xmlns: 'http://jabber.org/protocol/muc#owner'})
                .c('destroy', {jid: this.roomjid})
                .c('reason').t(reason_by_role).up().up().up();
                

            this.connection.sendIQ(
                destroyIQ,
                function (result) {
                    console.log('Destroyed room: ', this.roomjid, result);
                },
                function (error) {
                    console.log('Error in destroying room: ', this.roomjid, error);
                });

        },

        onModerationGranted: function (jid) {

        },

        // Updates Room Status on django page
        updateOpenRoom:function(roomName, roomType, callback){
            var httpRequest = new XMLHttpRequest();
            
            var payload = new Object();
            payload.room = ROOM_ID;
            payload.roomType  = roomType;
            var requestBody= JSON.stringify(payload);
            
                httpRequest.onreadystatechange = function(){ 
                   if (httpRequest.readyState === 4 &&
                           httpRequest.status === 300){
                   callback.call(JSON.parse(httpRequest.responseText)); 
                }
            };
            
            var csrftoken = getCookie('csrftoken');
            
            httpRequest.open('PUT', "http://" + HOSTNAME + "/openrooms/" + OPENROOM_ID);
            httpRequest.setRequestHeader("X-CSRFToken", csrftoken);
            httpRequest.setRequestHeader('Content-Type', 'application/json');
            httpRequest.send(requestBody);
        },

        registerShowRequest: function(roomInstance, userId, showType, callback){
            var httpRequest = new XMLHttpRequest();
            
            var payload = new Object();
            payload.room = roomInstance;
            payload.user  = userId;
            payload.requestType = showType;
            var requestBody= JSON.stringify(payload);
            
                httpRequest.onreadystatechange = function(){ 
                   if (httpRequest.readyState === 4 &&
                           httpRequest.status === 300){
                   callback.call(JSON.parse(httpRequest.responseText)); 
                }
            };
            
            var csrftoken = getCookie('csrftoken');
            
            httpRequest.open('POST', "http://" + HOSTNAME + "/showrequests/");
            httpRequest.setRequestHeader("X-CSRFToken", csrftoken);
            httpRequest.setRequestHeader('Content-Type', 'application/json');
            httpRequest.send(requestBody);
        },




        sendPresence: function () {
            var pres = $pres({to: this.presMap['to'] });
            pres.c('x', {xmlns: this.presMap['xns']});

            if (this.presMap['password']) {
                pres.c('password').t(this.presMap['password']).up();
            }

            pres.up();

            // Send XEP-0115 'c' stanza that contains our capabilities info
            if (this.connection.caps) {
                this.connection.caps.node = config.clientNode;
                pres.c('c', this.connection.caps.generateCapsAttrs()).up();
            }

            pres.c('user-agent', {xmlns: 'http://jitsi.org/jitmeet/user-agent'})
                .t(navigator.userAgent).up();

            if (this.presMap['bridgeIsDown']) {
                pres.c('bridgeIsDown').up();
            }

            if (this.presMap['email']) {
                pres.c('email').t(this.presMap['email']).up();
            }

            if (this.presMap['userId']) {
                pres.c('userId').t(this.presMap['userId']).up();
            }

            if (this.presMap['displayName']) {
                // XEP-0172
                pres.c('nick', {xmlns: 'http://jabber.org/protocol/nick'})
                    .t(this.presMap['displayName']).up();
            }

            if (this.presMap['audions']) {
                pres.c('audiomuted', {xmlns: this.presMap['audions']})
                    .t(this.presMap['audiomuted']).up();
            }

            if (this.presMap['videons']) {
                pres.c('videomuted', {xmlns: this.presMap['videons']})
                    .t(this.presMap['videomuted']).up();
            }

            if (this.presMap['statsns']) {
                var stats = pres.c('stats', {xmlns: this.presMap['statsns']});
                for (var stat in this.presMap["stats"])
                    if (this.presMap["stats"][stat] != null)
                        stats.c("stat", {name: stat, value: this.presMap["stats"][stat]}).up();
                pres.up();
            }

            if (this.presMap['prezins']) {
                pres.c('prezi',
                    {xmlns: this.presMap['prezins'],
                        'url': this.presMap['preziurl']})
                    .c('current').t(this.presMap['prezicurrent']).up().up();
            }

            if (this.presMap['etherpadns']) {
                pres.c('etherpad', {xmlns: this.presMap['etherpadns']})
                    .t(this.presMap['etherpadname']).up();
            }

            if (this.presMap['medians']) {
                pres.c('media', {xmlns: this.presMap['medians']});
                var sourceNumber = 0;
                Object.keys(this.presMap).forEach(function (key) {
                    if (key.indexOf('source') >= 0) {
                        sourceNumber++;
                    }
                });
                if (sourceNumber > 0)
                    for (var i = 1; i <= sourceNumber / 3; i++) {
                        pres.c('source',
                            {type: this.presMap['source' + i + '_type'],
                                ssrc: this.presMap['source' + i + '_ssrc'],
                                direction: this.presMap['source' + i + '_direction']
                                    || 'sendrecv' }
                        ).up();
                    }
            }

            pres.up();
            this.connection.send(pres);
        },
        addDisplayNameToPresence: function (displayName) {
            this.presMap['displayName'] = displayName;
        },
        addMediaToPresence: function (sourceNumber, mtype, ssrcs, direction) {
            if (!this.presMap['medians'])
                this.presMap['medians'] = 'http://estos.de/ns/mjs';

            this.presMap['source' + sourceNumber + '_type'] = mtype;
            this.presMap['source' + sourceNumber + '_ssrc'] = ssrcs;
            this.presMap['source' + sourceNumber + '_direction'] = direction;
        },
        clearPresenceMedia: function () {
            var self = this;
            Object.keys(this.presMap).forEach(function (key) {
                if (key.indexOf('source') != -1) {
                    delete self.presMap[key];
                }
            });
        },
        addPreziToPresence: function (url, currentSlide) {
            this.presMap['prezins'] = 'http://jitsi.org/jitmeet/prezi';
            this.presMap['preziurl'] = url;
            this.presMap['prezicurrent'] = currentSlide;
        },
        removePreziFromPresence: function () {
            delete this.presMap['prezins'];
            delete this.presMap['preziurl'];
            delete this.presMap['prezicurrent'];
        },
        addCurrentSlideToPresence: function (currentSlide) {
            this.presMap['prezicurrent'] = currentSlide;
        },
        getPrezi: function (roomjid) {
            return this.preziMap[roomjid];
        },
        addEtherpadToPresence: function (etherpadName) {
            this.presMap['etherpadns'] = 'http://jitsi.org/jitmeet/etherpad';
            this.presMap['etherpadname'] = etherpadName;
        },
        addAudioInfoToPresence: function (isMuted) {
            this.presMap['audions'] = 'http://jitsi.org/jitmeet/audio';
            this.presMap['audiomuted'] = isMuted.toString();
        },
        addVideoInfoToPresence: function (isMuted) {
            this.presMap['videons'] = 'http://jitsi.org/jitmeet/video';
            this.presMap['videomuted'] = isMuted.toString();
        },
        addConnectionInfoToPresence: function (stats) {
            this.presMap['statsns'] = 'http://jitsi.org/jitmeet/stats';
            this.presMap['stats'] = stats;
        },
        findJidFromResource: function (resourceJid) {
            if (resourceJid &&
                resourceJid === Strophe.getResourceFromJid(this.myroomjid)) {
                return this.myroomjid;
            }
            var peerJid = null;
            Object.keys(this.members).some(function (jid) {
                peerJid = jid;
                return Strophe.getResourceFromJid(jid) === resourceJid;
            });
            return peerJid;
        },
        addBridgeIsDownToPresence: function () {
            this.presMap['bridgeIsDown'] = true;
        },
        addEmailToPresence: function (email) {
            this.presMap['email'] = email;
        },
        addUserIdToPresence: function (userId) {
            this.presMap['userId'] = userId;
        },
        isModerator: function () {
            return this.role === 'moderator';
        },
        getMemberRole: function (peerJid) {
            if (this.members[peerJid]) {
                return this.members[peerJid].role;
            }
            return null;
        },
        onParticipantLeft: function (jid) {

            eventEmitter.emit(XMPPEvents.MUC_LEFT, jid);

            this.connection.jingle.terminateByJid(jid);

            if (this.getPrezi(jid)) {
                $(document).trigger('presentationremoved.muc',
                    [jid, this.getPrezi(jid)]);
            }

            Moderator.onMucLeft(jid);
        },
        parsePresence: function (from, memeber, pres) {
            if($(pres).find(">bridgeIsDown").length > 0 && !bridgeIsDown) {
                bridgeIsDown = true;
                eventEmitter.emit(XMPPEvents.BRIDGE_DOWN);
            }

            if(memeber.isFocus)
                return;

            var self = this;
            // Remove old ssrcs coming from the jid
            Object.keys(this.ssrc2jid).forEach(function (ssrc) {
                if (self.ssrc2jid[ssrc] == from) {
                    delete self.ssrc2jid[ssrc];
                }
            });

            var changedStreams = [];
            $(pres).find('>media[xmlns="http://estos.de/ns/mjs"]>source').each(function (idx, ssrc) {
                //console.log(jid, 'assoc ssrc', ssrc.getAttribute('type'), ssrc.getAttribute('ssrc'));
                var ssrcV = ssrc.getAttribute('ssrc');
                self.ssrc2jid[ssrcV] = from;
                JingleSession.notReceivedSSRCs.push(ssrcV);


                var type = ssrc.getAttribute('type');

                var direction = ssrc.getAttribute('direction');

                changedStreams.push({type: type, direction: direction});

            });

            eventEmitter.emit(XMPPEvents.CHANGED_STREAMS, from, changedStreams);

            var displayName = !config.displayJids
                ? memeber.displayName : Strophe.getResourceFromJid(from);

            if (displayName && displayName.length > 0)
            {
                eventEmitter.emit(XMPPEvents.DISPLAY_NAME_CHANGED, from, displayName);
            }


            var id = $(pres).find('>userID').text();
            var email = $(pres).find('>email');
            if(email.length > 0) {
                id = email.text();
            }

            eventEmitter.emit(XMPPEvents.USER_ID_CHANGED, from, id);
        }
    });
};

function getCookie(name) {
    var cookieValue = null;
    if (document.cookie && document.cookie != '') {
        var cookies = document.cookie.split(';');
        for (var i = 0; i < cookies.length; i++) {
            var cookie = jQuery.trim(cookies[i]);
            // Does this cookie string begin with the name we want?
            if (cookie.substring(0, name.length + 1) == (name + '=')) {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}


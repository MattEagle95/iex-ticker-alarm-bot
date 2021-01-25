const express = require("express");
const compression = require("compression");
const bodyParser = require("body-parser");
const cors = require("cors");
const config = require("./config.json");
const packagejson = require("../package.json");
const symbols = require("./data/symbols.json");
const symbolsCrypto = require("./data/symbols-crypto.json");
const subscriptionHandler = require('./subscriptionHandler')

const swaggerUi = require('swagger-ui-express')
const swaggerDocument = require('./swagger.json');

const app = express();

const users = []
let messages = 0
let lastMessage = 0
let isSystemHours = false
let lastUpdateTime = Date.now()
let lastPing = 0
let updateSize = 0

let lastUpdateTimeCrypto = Date.now()
let lastPingCrypto = 0
let updateSizeCrypto = 0

app.use(
  cors({
    origin(origin, cb) {
      const whitelist = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : [];
      cb(null, whitelist.includes(origin));
    },
    credentials: true
  })
);
app.get('/', (req, res) => {
  res.send('Hello World!')
})
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.use(compression());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.post("/subscription", subscriptionHandler.handlePushNotificationSubscription);
app.get("/subscription/:id", subscriptionHandler.sendPushNotification);

var crypto = require("crypto");

const winston = require('winston');
const logFormat = winston.format.printf( ({ level, message, timestamp, metadata }) => {
  let msg = `${timestamp} ${level} : ${message} `

  if(metadata.stack) {
    return msg + '\n' + metadata.stack
  }

  if(metadata.durationMs) {
    msg += '[took ' + metadata.durationMs + ' ms]'
    metadata.durationMs = undefined
  }

  if(JSON.stringify(metadata) !== '{}') {
    msg += JSON.stringify(metadata)
  }

  return msg
});
const logger = winston.createLogger({
  format: winston.format.combine(
      winston.format.colorize(),
      winston.format.splat(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.metadata({ fillExcept: ['timestamp', 'level', 'message'] }),
      logFormat
  ),
  transports: [
      new winston.transports.Console({
          level: 'info',
          handleExceptions: true
      }),
      new winston.transports.File({
          level: 'info',
          dirname: config.LOG.DIR,
          filename: config.LOG.FILENAME,
          handleExceptions: true
      }),
      new winston.transports.File({
          level: 'error',
          dirname: config.LOG.DIR,
          filename: config.LOG.FILENAME,
          handleExceptions: true
      })
  ],
  
  exitOnError: false
})
logger.info('server started')

let lastData = []
let lastDataCrypto = []
let cryptoData = []
let replyMessages = []

const { Telegraf } = require('telegraf')
const extra = require('telegraf/extra')
const markdown = extra.markdown()

const markup = require('telegraf/markup')

const rateLimit = require('telegraf-ratelimit')

const bot = new Telegraf(config.TELEGRAM.BOT_TOKEN)
const limitConfig = {
  window: 60000,
  limit: 20,
  onLimitExceeded: (ctx, next) => {
    ctx.reply('Calm down, I cant work under pressure!')
  }
}

bot.use(rateLimit(limitConfig))

bot.command('start', (ctx) => {
  if(!users.find(x => x.chatid === ctx.message.chat.id)) {
    logger.info('added new user: ' + ctx.message.chat.id)

    users.push({
      chatid: ctx.message.chat.id,
      notifications: false,
      alarms: [],
      systemHoursNotification: true
    })
  }

  bot.telegram.sendAnimation(
    ctx.chat.id,
    {source : 'img/welcome.gif'}
  ).then(() => {
    ctx.reply(`
  */price <ticker|company>*
  _Get the current price for a ticker|company name_

  */list*
  _List and delete alarm notifications_

  */add <ticker> <price>*
  _Add alarm notification_

  */togglemarkethours*
  _Toggle notifications for market opening/closing_

  */about*

  */help*
  `, markdown)
}).catch(error => {
    console.error(error)
  })
})

bot.command('help', (ctx) => {
  ctx.reply(`
*Help*
  
  */price <ticker|company>*
  _Get the current price for a ticker|company name_
  
    */list*
    _List and delete alarm notifications_
  
    */add <ticker> <price>*
    _Add alarm notification_

    */togglemarkethours*
    _Toggle notifications for market opening/closing_
  
    */about*

    */help*
    `, markdown)
})

var dayjs = require('dayjs')

bot.on("message", (ctx, next) => {
  logger.info('chat: ' + ctx.message.chat.id + ' user: ' + ctx.message.from.first_name + ' message: ' + ctx.message.text)
  messages++
  lastMessage = Date.now()

  if(ctx.message.reply_to_message) {
    const msg = replyMessages.find(x => x.messageid === ctx.message.reply_to_message.message_id)
    if(replyMessages.find(x => x.messageid === ctx.message.reply_to_message.message_id)) {

      if(msg.command === 'price') {
        price(ctx.update.message.chat.id, ctx.message.text)
      }

      if(msg.command === 'add') {
        if(msg.data && msg.data.symbol) {
          add(ctx.update.message.chat.id, msg.data.symbol, ctx.message.text)
        } else {
          add(ctx.update.message.chat.id, ctx.message.text)
        }
      }

      const index = replyMessages.indexOf(replyMessages.find(x => x.messageid === ctx.message.reply_to_message.message_id));
      if (index > -1) {
        replyMessages.splice(index, 1);
      }
    }
  }

  next.call(ctx)
})

function price(chatid, symbol) {
  if(!symbol) {
    bot.telegram.sendMessage(chatid, `Insert a ticker or company name. Reply to this.`, {reply_markup: {
      force_reply: true
    }, ...markdown})
    .then(msg => {
      replyMessages.push({command: 'price', messageid: msg.message_id})
    })

    return
  }

  let ticker = lastData.find(x => x.symbol.toUpperCase() === symbol.toUpperCase())
  if(!ticker) {

    let tickerCrypto = symbolsCrypto.find(x => x.symbol.toUpperCase() === symbol.toUpperCase())
    if(!tickerCrypto) {
      if(symbol.toUpperCase().length < 3) {
        bot.telegram.sendMessage(chatid, `Too many results. Please be more specific about the name.`, markdown)
        return;
      }
  
      ticker = symbols.filter(x => x.name.toUpperCase().includes(symbol.toUpperCase()))
      tickerCrypto = symbolsCrypto.filter(x => x.name.toUpperCase().includes(symbol.toUpperCase()))
  
      let msg = ''
      let counter = 0
    
      ticker.forEach(tickerfound => {
        const tickerLastData = lastData.find(x => x.symbol.toUpperCase() === tickerfound.symbol.toUpperCase())
        if(tickerLastData) {
          counter++
          msg += `\n${tickerfound.symbol} - ${tickerfound.name} - ${Number(lastData.find(x => x.symbol.toUpperCase() === tickerfound.symbol.toUpperCase()).price).toFixed(2)} $`
        }
      });

      tickerCrypto.forEach(tickerfound => {
        const tickerLastData = cryptoData.find(x => x.symbol.toUpperCase() === tickerfound.symbol.toUpperCase())
        if(tickerLastData) {
          counter++
          msg += `\n${tickerfound.symbol} - ${tickerfound.name} - ${Number(cryptoData.find(x => x.symbol.toUpperCase() === tickerfound.symbol.toUpperCase()).price).toFixed(2)} $`
        }
      });
    
      if(counter === 0) {
        bot.telegram.sendMessage(chatid, 'Found 0 results.', markdown)
        return
      }
    
      if(counter > 1) {
        bot.telegram.sendMessage(chatid, 'Found ' + counter + ' results. (use ticker name for a single result)', markdown)
        .then(() => {
          bot.telegram.sendMessage(chatid, msg, markdown)
        })
        return
      }
    
      bot.telegram.sendMessage(chatid, msg, markdown)
      
      return
    }

    const cryptoPrice = cryptoData.find(x => x.symbol.toUpperCase() === tickerCrypto.symbol.toUpperCase()).price
    bot.telegram.sendMessage(chatid, `${symbol.toUpperCase()} - ${symbolsCrypto.find(x => x.symbol.toUpperCase() === symbol.toUpperCase()).name} - *${Number(cryptoPrice).toFixed(2)}* $`, markdown)

    return

  }

  bot.telegram.sendMessage(chatid, `${symbol.toUpperCase()} - ${symbols.find(x => x.symbol.toUpperCase() === symbol.toUpperCase()).name} - *${Number(ticker.price).toFixed(2)}* $`, markdown)
}

bot.command('search', (ctx) => {
  price(ctx.update.message.chat.id, ctx.update.message.text.split(' ')[1])
})

bot.command('price', (ctx) => {
  price(ctx.update.message.chat.id, ctx.update.message.text.split(' ')[1])
})

bot.command('list', (ctx) => {
  const user = users.find(x => x.chatid === ctx.message.chat.id)
  if(!user) {
    ctx.reply(`User not found`, markdown)

    return
  }

  let msg = `Your active alarms`
  msg += `\nTo delete one, click on it`
  let buttons = []
  if(user.alarms.length > 0) {
    buttons.push([markup.callbackButton('delete all', 'all')])
  }

    user.alarms.forEach(alarm => {
      if(alarm.price >= alarm.startPrice) {
        buttons.push([markup.callbackButton(alarm.symbol + ' - upwards - ' + Number(alarm.price).toFixed(2) + ' $', alarm.id)])
      }else if(alarm.price < alarm.startPrice) {
        buttons.push([markup.callbackButton(alarm.symbol + ' - downwards - ' + Number(alarm.price).toFixed(2) + ' $', alarm.id)])
      }
    });

  let m = markup.inlineKeyboard(buttons)

  ctx.reply(msg, {reply_markup: m, ...markdown})
})

bot.on('callback_query', (ctx) => {
  const user = users.find(x => x.chatid === ctx.chat.id)
  if(!user) {
    bot.telegram.sendMessage(ctx.chat.id, `User not found`, markdown)

    return
  }

  let buttons = []

  if(ctx.update.callback_query.data === 'all') {
    user.alarms = [];
  } else {
    const alarm = user.alarms.find(x => x.id === ctx.update.callback_query.data)
    if(alarm) {
      logger.info('deleted alarm ' + alarm.symbol)
      
      const index = user.alarms.indexOf(user.alarms.find(x => x.id === ctx.update.callback_query.data));
      if (index > -1) {
        user.alarms.splice(index, 1);
      }
  
      if(user.alarms.length > 0) {
        buttons.push([markup.callbackButton('delete all', 'all')])
      }
  
      user.alarms.forEach(alarm => {
        if(alarm.price >= alarm.startPrice) {
          buttons.push([markup.callbackButton(alarm.symbol + ' - upwards - ' + Number(alarm.price).toFixed(2), alarm.id)])
        } else if(alarm.price < alarm.startPrice) {
          buttons.push([markup.callbackButton(alarm.symbol + ' - downwards - ' + Number(alarm.price).toFixed(2), alarm.id)])
        }
      });
    }
  }

  if(buttons.length === 0) {
    buttons.push([markup.callbackButton('No active alarms set', 0)])
  }

  ctx.answerCbQuery()
  ctx.editMessageReplyMarkup(markup.inlineKeyboard(buttons))
});

function add(chatid, symbol, price) {
  if(!symbol) {
    bot.telegram.sendMessage(chatid, `Insert a ticker name. Reply to this.`, {reply_markup: {
      force_reply: true
    }, ...markdown})
    .then(msg => {
      replyMessages.push({command: 'add', messageid: msg.message_id})
    })

    return
  }

  let isCrypto = false

  let ticker = lastData.find(x => x.symbol.toUpperCase() === symbol.toUpperCase())
  if(!ticker) {
    let tickerCrypto = symbolsCrypto.find(x => x.symbol.toUpperCase() === symbol.toUpperCase())
    if(!tickerCrypto) {
      if(symbol.toUpperCase().length < 3) {
        bot.telegram.sendMessage(chatid, `Too many results. Please be more specific about the name.`, markdown)
        return;
      }
  
      ticker = symbols.filter(x => x.name.toUpperCase().includes(symbol.toUpperCase()))
      tickerCrypto = symbolsCrypto.filter(x => x.name.toUpperCase().includes(symbol.toUpperCase()))
  
      let msg = ''
      let counter = 0
      let cryptoCounter = 0
    
      ticker.forEach(tickerfound => {
        const tickerLastData = lastData.find(x => x.symbol.toUpperCase() === tickerfound.symbol.toUpperCase())
        if(tickerLastData) {
          counter++
          msg += `\n${tickerfound.symbol} - ${tickerfound.name} - ${Number(lastData.find(x => x.symbol.toUpperCase() === tickerfound.symbol.toUpperCase()).price).toFixed(2)} $`
        }
      });

      tickerCrypto.forEach(tickerfound => {
        const tickerLastData = cryptoData.find(x => x.symbol.toUpperCase() === tickerfound.symbol.toUpperCase())
        if(tickerLastData) {
          cryptoCounter++
          msg += `\n${tickerfound.symbol} - ${tickerfound.name} - ${Number(cryptoData.find(x => x.symbol.toUpperCase() === tickerfound.symbol.toUpperCase()).price).toFixed(2)} $`
        }
      });
    
      if((counter + cryptoCounter) === 0) {
        bot.telegram.sendMessage(chatid, 'Found 0 results.', markdown)
        return
      }
    
      if((counter + cryptoCounter) > 1) {
        bot.telegram.sendMessage(chatid, 'Found ' + (counter + cryptoCounter) + ' results. Please be more specific and use the ticker name.', markdown)
        .then(() => {
          bot.telegram.sendMessage(chatid, msg, markdown)
        })
        return
      }

      if(cryptoCounter === 1) {
        ticker = cryptoData.find(x => x.symbol.toUpperCase() === tickerCrypto[0].symbol.toUpperCase())
        isCrypto = true
      } else {
        ticker = lastData.find(x => x.symbol.toUpperCase() === ticker[0].symbol.toUpperCase())
      }
    } else {
      ticker = cryptoData.find(x => x.symbol.toUpperCase() === tickerCrypto.symbol.toUpperCase())
      isCrypto = true
    }
  }

  if(!price) {
    bot.telegram.sendMessage(chatid, `Insert a price for the alarm. Reply to this.`, {reply_markup: {
      force_reply: true
    }, ...markdown})
    .then(msg => {
      replyMessages.push({command: 'add', messageid: msg.message_id, data: {symbol: symbol}})
    })

    return
  }

  if(isNaN(price)) {
    bot.telegram.sendMessage(chatid, `Price must be a number`, markdown)
    
    return
  }

  price = Number(price).toFixed(2)

  if (price <= 0) {
    bot.telegram.sendMessage(chatid, `Price must be a number above 0`, markdown)
    
    return
  }

  if (price > 999999) {
    bot.telegram.sendMessage(chatid, `Price is too high`, markdown)
    
    return
  }

  const user = users.find(x => x.chatid === chatid)
  if(!user) {
    bot.telegram.sendMessage(chatid, `User not found`, markdown)

    return
  }

  users.find(x => x.chatid === chatid).alarms.push({
    id: crypto.randomBytes(16).toString('hex'),
    symbol: ticker.symbol,
    type: 'auto',
    startPrice: Number(ticker.price).toFixed(2),
    price: price
  })

  logger.info('added alarm ' + ticker.symbol)

  bot.telegram.sendMessage(chatid, `Added alarm for *${ticker.symbol}* at *${Number(price).toFixed(2)} $* (current: ${Number(ticker.price).toFixed(2)} $)`, markdown)
}

bot.command('add', (ctx) => {
  add(ctx.update.message.chat.id, ctx.update.message.text.split(' ')[1], ctx.update.message.text.split(' ')[2])
})

bot.command('togglemarkethours', (ctx) => {
  const user = users.find(x => x.chatid === ctx.message.chat.id)
  if(!user) {
    bot.telegram.sendMessage(chatid, `User not found`, markdown)

    return
  }

  users.find(x => x.chatid === ctx.message.chat.id).systemHoursNotification = !users.find(x => x.chatid === ctx.message.chat.id).systemHoursNotification
  bot.telegram.sendMessage(ctx.message.chat.id, `Set notifications for market opening/closing to ${users.find(x => x.chatid === ctx.message.chat.id).systemHoursNotification}`, markdown)
})

bot.command('about', (ctx) => {
  bot.telegram.sendMessage(ctx.update.message.chat.id, `
*WatchYoShitBot*
Version: ${packagejson.version}

Market-data is refreshed every ${config.API.DELAY / 60000} minutes between 9am and 5pm.
Cryptocurrency data is refreshed every ${config.API_CRYPTO.DELAY / 60000} minutes 24/7.

Made by Colin 👋
  `, markdown)
})

bot.hears(['hey', 'hey!', 'hi', 'hi!', 'hello', 'hello!', 'hallo', 'hallo!'], (ctx) => {
  let randomNumber = Math.random()
  if(randomNumber < 0.3) {
    ctx.reply('to the moon! 🚀')
  } else if(randomNumber < 0.5) {
    ctx.reply('stonks! 👋')
  } else {
    ctx.reply('hey! 👋')
  }
})

function byteCount(s) {
  return (encodeURI(s).split(/%..|./).length - 1) / 1000;
}

bot.command('status', (ctx) => {
  ctx.reply(`
User: ${users.length}
Messages: ${messages}
LastMessage: ${dayjs(lastMessage).format('YYYY-MM-DD HH:mm:ss')}

SystemHour: ${isSystemHours}
LastUpdate: ${dayjs(lastUpdateTime).format('YYYY-MM-DD HH:mm:ss')}
LastPing: ${Number(lastPing).toFixed(2)} ms
LastUpdateSize: ${Number(byteCount(JSON.stringify(lastData))).toFixed(2)} kb
UpdateSize: ${Number(updateSize).toFixed(2)} kb

LastUpdateCrypto: ${dayjs(lastUpdateTimeCrypto).format('YYYY-MM-DD HH:mm:ss')}
LastPingCrypto: ${Number(lastPingCrypto).toFixed(2)} ms
LastUpdateSizeCrypto: ${Number(byteCount(JSON.stringify(lastDataCrypto))).toFixed(2)} kb
UpdateSizeCrypto: ${Number(updateSizeCrypto).toFixed(2)} kb`, markdown)
})

bot.command('stop', (ctx) => {
  bot.stop()
})

bot.launch()

const axios = require('axios');
this.interval = setInterval(() => {
  if(!isSystemHours) {
    return
  }
  
  getDataJob()
  }, config.API.DELAY)

  this.interval = setInterval(() => {
    getDataCryptoJob()
    }, config.API_CRYPTO.DELAY)

  function getDataJob() {
  const a = Date.now()
  axios.get(config.API.URL)
    .then(response => {
      lastData = response.data
      lastUpdateTime = Date.now()
      updateSize = updateSize + byteCount(JSON.stringify(lastData))
      lastPing = Date.now() - a

      response.data.forEach(data => {
        users.forEach(user => {
          user.alarms.filter(x => x.symbol === data.symbol).forEach(alarm => {
            
            if(alarm.price > alarm.startPrice && data.price > alarm.price) {
              bot.telegram.sendMessage(user.chatid, `
              ${alarm.symbol} has reached ${alarm.price}
              `, markdown)
            }

            if(alarm.price < alarm.startPrice && data.price < alarm.price) {
              bot.telegram.sendMessage(user.chatid, `
              ${alarm.symbol} has reached ${alarm.price}
              `, markdown)
            }

            alarm.startPrice = data.price
          })
        })
      });

      logger.info('get-data job success')
    })
    .catch(error => {
      logger.error('get-data job failed', error)
    })
    .finally(() => {
      logger.info('get-data job finished and took ' + (Date.now() - a) + 'ms')
    })
  }

  function getDataCryptoJob() {
    const a = Date.now()

    let ids = ''
    symbolsCrypto.forEach(symbolCrypto => {
      if(ids === '') {
        ids += symbolCrypto.id
      }
      ids += ('%2C' + symbolCrypto.id)
    });

      axios.get(config.API_CRYPTO.URL + '?ids=' + ids + '&vs_currencies=usd')
      .then(response => {
        lastDataCrypto = response.data
        lastUpdateTimeCrypto = Date.now()
        updateSizeCrypto = updateSizeCrypto + byteCount(JSON.stringify(response.data))
        lastPingCrypto = Date.now() - a
        
        cryptoDataTemp = []

        symbolsCrypto.forEach(cryptoSymbol => {
          if(response.data[cryptoSymbol.id]) {
            cryptoDataTemp.push({
              symbol: cryptoSymbol.symbol.toUpperCase(),
              price: response.data[cryptoSymbol.id].usd,
              size: 0,
              time: Date.now()
            })
          }
        });

        cryptoData = cryptoDataTemp
  
        cryptoData.forEach(data => {
          users.forEach(user => {
            user.alarms.filter(x => x.symbol === data.symbol).forEach(alarm => {
              
              if(alarm.price > alarm.startPrice && data.price > alarm.price) {
                bot.telegram.sendMessage(user.chatid, `
                ${alarm.symbol} has reached ${alarm.price}
                `, markdown)
              }
  
              if(alarm.price < alarm.startPrice && data.price < alarm.price) {
                bot.telegram.sendMessage(user.chatid, `
                ${alarm.symbol} has reached ${alarm.price}
                `, markdown)
              }
  
              alarm.startPrice = data.price
            })
          })
        });
  
        logger.info('get-data-crypto job success')
      })
      .catch(error => {
        logger.error('get-data-crypto job failed', error)
      })
      .finally(() => {
        logger.info('get-data-crypto job finished and took ' + (Date.now() - a) + 'ms')
      })
    }

  getDataJob()
  getDataCryptoJob()

const socket = require('socket.io-client')(config.API.SYSTEM_HOURS_URL)

socket.on('connect', () => {
  socket.emit('subscribe', JSON.stringify({
    channels: ['systemevent'],
  }))
})

socket.on('message', (event) => {
  logger.info('socket io event')
  logger.info(event)

  let msg = '';

  if(event.data.systemEvent === 'S') {
    isSystemHours = true
    msg = 'System hours opened'
  }

  if(event.data.systemEvent === 'R') {
    msg = 'Regular market opened'
  }

  if(event.data.systemEvent === 'M') {
    msg = 'Regular market closed'
  }

  if(event.data.systemEvent === 'E') {
    isSystemHours = false
    msg = 'System hours closed'
  }

  if(msg !== '') {
    users.forEach(user => {
        if(user.systemHoursNotification) {
          bot.telegram.sendMessage(user.chatid, msg)
        }
    })
  }
})

module.exports = app;

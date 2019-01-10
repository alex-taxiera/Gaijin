const Command = require('../command')
const Await = require('../await')

/**
 * A class reprsenting the command handler.
 */
class CommandHandler {
  /**
   * Create a CommandHandler
   * @param {String}            prefix        The prefix of commands.
   * @param {Client}            client        The Eris client.
   * @param {String}            ownerId       The ID of the bot owner.
   * @param {QueryBuilder}      knex          The simple-knex query builder.
   * @param {Command[]|Command} [commands=[]] List of commands to load initially.
   */
  constructor (prefix, client, ownerId, knex, commands = []) {
    /**
     * The prefix of commands.
     * @type {String}
     */
    this._prefix = prefix
    /**
     * The Eris Client.
     * @type {Client}
     */
    this._client = client
    /**
     * The simple-knex query builder.
     * @type {QueryBuilder}
     */
    this._knex = knex
    /**
     * Array of commands.
     * @type {Map<String, Command>}
     */
    this._commands = new Map()
    /**
     * An object containing message data used to wait for user response.
     * @type {Map<String, AwaitData>}
     */
    this._awaits = new Map()
    /**
     * The ID of the bot owner.
     * @type {String}
     */
    this._ownerId = ownerId
    /**
     * Map of replacers.
     * @type {Map<String, Replacer>}
     */
    this._replacers = new Map([
      ['LAST', {
        key: 'LAST',
        desc: 'Last message sent in channel by bot',
        action: ({ msg }) => {
          const lastMessage = msg.channel.lastMessage
          return lastMessage && lastMessage.content ? lastMessage.content : 'No previous message'
        }
      }], ['DATE', {
        key: 'DATE',
        desc: 'Current date',
        action: () => {
          const d = Date()
          // SWITCHING TO EDT
          const date = new Date(d.substring(0, d.indexOf('GMT') + 4) + '0 (UTC)').toJSON()
          return date.substring(0, date.length - 8)
        }
      }], ['IN', {
        key: 'IN',
        desc: 'The current date plus the number of hours inputted',
        start: true,
        action: ({ msg, key }) => {
          const num = key.split(' ')[1]
          if (isNaN(Number(num))) return 'Input is not a number'
          const d = new Date(Date.now() + (Number(num) * 3600000)).toString()
          // SWITCHING TO EDT
          const date = new Date(d.substring(0, d.indexOf('GMT') + 4) + '0 (UTC)').toJSON()
          return date.substring(0, date.length - 8)
        }
      }]
    ])
    // load some commands
    this.loadCommands(commands)
  }

  /**
   * Load commands.
   * @param {Command[]|Command} commands The command(s) to load.
   */
  loadCommands (commands) {
    if (commands instanceof Array) {
      for (let i = 0; i < commands.length; i++) {
        this._loadCommand(commands[i])
      }
    } else {
      this._loadCommand(commands)
    }
  }

  /**
   * Handle incoming Discord messages.
   * @param {Message} msg    The Discord message.
   */

  async handle (msg) {
    console.log('checking prefix')
    let text = msg.content.replace(new RegExp(`^<@!?${this._client.user.id}> ?`), this._prefix)
    console.log('text', text)
    if (!text.startsWith(this._prefix)) return
    console.log('removing prefix and running replacers on: ', text)
    text = text.substring(this._prefix.length)
    text = this._runReplacers(text)
    console.log('checking awaits')
    let awaited = this._awaits.get(msg.channel.id + msg.author.id)
    if (awaited && ((Date.now() - awaited.timestamp) > awaited.timeout || !awaited.check(msg))) {
      console.log('bad await')
      return awaited.clear()
    }
    console.log('splitting args')
    let args = text.split(' ')
    console.log('args', args)
    const keyword = args.shift()
    console.log('keyword', keyword)
    const command = awaited || this._commands.get(keyword)
    console.log('command', command)

    if (!command) return
    if (command.restricted && msg.author.id !== this._ownerId) throw Error('This command is either temporarily disabled, or private.')
    console.log('santizing args')
    args = this._sanitizeArgs(command, args)
    console.log('args', args)
    if (command.args && !args) throw Error('Invalid arguments. Reference the help menu.')
    let dbData
    if (command.dbTable) {
      dbData = await this._handleDBRequest(command.dbTable, msg.author.id)
    }

    const result = await command.action({
      client: this._client,
      msg,
      args: args,
      [command.dbTable]: dbData,
      knex: this._knex,
      lastResponse: awaited ? command.lastResponse : null
    })

    if (typeof result === 'string' || result === undefined) return result
    const {
      content,
      embed,
      wait,
      file
    } = result

    if (wait && wait instanceof Await) {
      this._addAwait(wait)
    }
    return content || embed || file ? { content, embed, file } : undefined
  }

  _handleDBRequest (table, id) {
    return this._knex.insert({ table, data: { id } })
      .catch(ignore => ignore)
      .finally(() => this._knex.get({ table, where: { id } }))
  }

  /**
   * Check message content for stuff to replace.
   * @private
   * @param   {String} content The message content to run the replacers against.
   * @returns {String} The message content after replacement.
   */
  _runReplacers (content) {
    return content.replace(/\|(.+?)\|/g, (content, capture) => {
      const split = capture.split(' ')
      const key = this._keys.find(e => e.start && split.length > 1 ? e.key.startsWith(split[0]) : e.key === capture)
      return key ? key.action({ content, capture }) : 'Invalid Key'
    })
  }

  /**
   * Load a command.
   * @private
   * @param   {Command} command The command to load.
   */
  _loadCommand (command) {
    if (!(command instanceof Command)) throw TypeError('Not a command:\n', command)
    this._commands.set(command.name, command)
  }
  _sanitizeArgs (command, args) {
    const start = Date.now()
    const chars = args.join(' ').split('')
    const cleaned = []
    for (let i = 0; i < command.args.length; i++) {
      const delim = command.args[i].delim || ' '
      if (!cleaned[i]) {
        cleaned[i] = ''
      }
      for (let j = cleaned.join(' ').length; j < chars.length; j++) {
        const ch = chars[j]
        if (i === (command.args.length - 1)) {
          cleaned[i] += ch
        } else {
          if (ch === delim) {
            break
          } else {
            cleaned[i] += ch
          }
        }
      }
      if (!cleaned[i]) {
        cleaned.pop()
      }
    }
    console.log(`sanitize args took ${Date.now() - start}ms`)
    return cleaned
  }
  /**
   * Set an await.
   * @param {Message} msg  The message that started it all.
   * @param {Await}   wait The command we are awaiting.
   */
  async _addAwait (msg, wait) {
    const id = msg.channel.id + msg.author.id
    const timer = setTimeout(() => this._awaits.delete(id), wait.timeout)
    this._awaits.set(id, {
      id,
      lastResponse: msg,
      ...wait,
      timestamp: Date.now(),
      timer,
      clear: () => {
        clearTimeout(timer)
        this._awaits.delete(id)
      }
    })
  }
}

module.exports = CommandHandler

/**
 * Context of awaiting messages.
 * @typedef  {Object}   AwaitData
 * @property {String}   id           The ID of the await.
 * @property {Message}  lastResponse The last message the bot sent in regards to this chain.
 * @property {Number}   timestamp    When the await was created.
 * @property {Number}   timeout      How many ms to wait before deleing the await.
 * @property {Timeout}  timer        Timeout that will delete the await.
 * @property {Function} clear        A function that will clear the delete timer and delete the await.
 * @property {Function} check        A function to validate a future response.
 * @property {Function} action       The action of the await command.
 */
/**
 * Fancy keyword replacer.
 * @typedef  {Object}   Replacer
 * @property {String}   key      The keyword to replace.
 * @property {String}   desc     A description of what it does.
 * @property {Boolean}  start    Dunno what this is.
 * @property {Function} action   Function returning the string to replace with. (param is an object containing: content, capture)
 */
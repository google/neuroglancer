export const data_schemes = ["precomputed"] as const;
export type DataScheme = typeof data_schemes[number];
export function ensureDataScheme(value: string): DataScheme{
    const variant = data_schemes.find(variant => variant === value)
    if(variant === undefined){
        throw Error(`Invalid data scheme: ${value}`)
    }
    return variant
}

export const protocols = ["http", "https"] as const;
export type Protocol = typeof protocols[number];
export function ensureProtocol(value: string): Protocol{
    const variant = protocols.find(variant => variant === value)
    if(variant === undefined){
        throw Error(`Invalid protocol: ${value}`)
    }
    return variant
}


export class Url{
    public readonly datascheme?: DataScheme
    public readonly protocol: Protocol
    public readonly hostname: string
    public readonly host: string
    public readonly port?: number
    public readonly path: string
    public readonly search: Map<string, string>
    public readonly hash?: string
    public readonly schemeless_raw: string
    public readonly raw: string
    public readonly double_protocol_raw: string

    constructor(params: {
        datascheme?: DataScheme,
        protocol: Protocol,
        hostname: string,
        port?: number,
        path: string,
        search?: Map<string, string>,
        hash?: string,
    }){
        if(!params.path.startsWith("/")){
            throw Error(`Path '${params.path}' is not absolute`)
        }
        var path_parts = new Array<string>()
        for(let part of  params.path.split("/")){
            if(part == "." || part == ""){
                continue;
            }if(part == ".."){
                if(path_parts.length > 0){
                    path_parts.pop()
                }
            }else{
                path_parts.push(part)
            }
        }

        this.datascheme = params.datascheme
        this.protocol = params.protocol
        this.hostname = params.hostname
        this.host = params.hostname + (params.port === undefined ? "" : `:${params.port}`)
        this.port = params.port
        this.path = "/" + path_parts.join("/")
        this.search = params.search || new Map<string, string>()
        this.hash = params.hash
        this.schemeless_raw = `${this.protocol}://${this.host}${this.path}`

        if(this.search.size > 0){
            const encoded_search = "?" + Array.from(this.search)
                .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value))
                .join("&")
            this.schemeless_raw += encoded_search
        }
        if(this.hash){
            this.schemeless_raw += "#" + this.hash
        }

        if(this.datascheme){
            this.raw = `${this.datascheme}+${this.schemeless_raw}`
            this.double_protocol_raw = `${this.datascheme}://${this.schemeless_raw}`
        }else{
            this.raw = this.schemeless_raw
            this.double_protocol_raw = this.raw
        }
    }

    public static readonly url_pattern = new RegExp(
        "(" +
            `(?<datascheme>${data_schemes.join("|").replace("+", "\\+")})` + String.raw`(\+|://)` +
        ")?" +

        `(?<protocol>${protocols.join("|").replace("+", "\\+")})` + "://" +

        String.raw`(?<hostname>[0-9a-z\-\.]+)` +

        "(:" +
            String.raw`(?<port>\d+)` +
        ")?" +

        String.raw`(?<path>/[^?]*)` +

        String.raw`(\?` +
            "(?<search>[^#]*)" +
        ")?" +

        "(#" +
            "(?<hash>.*)" +
        ")?",

        "i"
    )

    public static parse(url: string): Url{
        const match = url.match(Url.url_pattern)
        if(match === null){
            throw Error(`Invalid URL: ${url}`);
        }
        const groups = match.groups!
        const raw_datascheme = groups["datascheme"]
        const raw_port = groups["port"]
        const raw_search = groups["search"]
        let parsed_search = new URLSearchParams(raw_search || "")
        var search =  new Map<string, string>(parsed_search.entries())

        return new Url({
            datascheme: raw_datascheme === undefined ? undefined : ensureDataScheme(raw_datascheme),
            protocol: ensureProtocol(groups["protocol"]),
            hostname: groups["hostname"],
            port: raw_port === undefined ? undefined : parseInt(raw_port),
            path: groups["path"],
            search: search,
            hash: groups["hash"]
        })
    }

    public updatedWith(params: {
        datascheme?: DataScheme,
        protocol?: Protocol,
        hostname?: string,
        port?: number,
        path?: string,
        search?: Map<string, string>,
        extra_search?: Map<string, string>
        hash?: string,
    }): Url{
        var new_search = new Map<string, string>()
        Array.from(params.search || this.search).forEach(([key, value]) => new_search.set(key, value))
        Array.from(params.extra_search || new Map<string, string>()).forEach(([key, value]) => new_search.set(key, value))

        return new Url({
            datascheme: params.datascheme === undefined ? this.datascheme : params.datascheme,
            protocol: params.protocol === undefined ? this.protocol : params.protocol,
            hostname: params.hostname === undefined ? this.hostname : params.hostname,
            port: params.port === undefined ? this.port : params.port,
            path: params.path === undefined ? this.path : params.path,
            search: new_search,
            hash: params.hash === undefined ? this.hash : params.hash,
        })
    }

    public get parent(): Url{
        return this.joinPath("..")
    }

    public joinPath(subpath: string): Url{
        var new_path = this.path.endsWith("/") ? this.path + subpath + "/" : this.path + "/" + subpath
        return this.updatedWith({path: new_path})
    }

    public ensureDataScheme(datascheme: DataScheme): Url{
        if(this.datascheme && this.datascheme != datascheme){
            throw Error(`Url ${this.raw} had unexpected datascheme: ${this.datascheme}. Expected ${datascheme}`)
        }
        return this.updatedWith({
            datascheme: datascheme
        })
    }

    public get name(): string{
        return this.path.split("/").slice(-1)[0]
    }

    public equals(other: Url): boolean{
        return this.double_protocol_raw == other.double_protocol_raw
    }
}

# GHI

## 1 - Abstract

***Houston, We Have a Solution***

GHI, or the General Hardware Interface, is a set of communication conventions and an associated
JSON format for IoT telemetry.

## 2 - Contents

### 2.1 - GHI Nodes

A device acting as a GHI endpoint is referred to as a GHI node.

#### 2.1.1 - Server

The primary interface to a GHI node is an endpoint on an HTTP server which is running on the
device, generally located at the root URL of the server.

A GHI node's state may be serialized in the GHI format. This state may be retrieved in the GHI
format using a GET request to the aforementioned endpoint, and may be updated with a POST request
containing new state content serialized in the GHI format.

Alternatively, if the server receives a POST request containing a raw HTTP request as its body, it
shall execute said request as a proxy, granting the client access to devices on its local network.

A GHI node's state may include tokens which, if present, indicate that one must be included as a
bearer token in the headers of any request made to its server.

#### 2.1.2 - Channels

The state of a GHI node is to include its channels, these being its physical I/O interfaces and its
command line. The serialization of each channel is to include input to feed through said channel on
the next loop, and the output recieved via said channel on the last loop, as well as the channel's
type along with a unique ID to distinguish channels of the same type.

#### 2.1.3 - Satellites

If a device is within communication reach of a GHI node, the GHI node is to list it in its state as
a satellite device, and attempt to integrate said satellite's channels into its own state. The
serialization of all available channels should be flat, and satellites should be serialized as
channels with information regarding which channels in the state belong to them. If using a device
channel itself to deliver input, the input, rather than consisting of raw values, may consist of
commands.

#### 2.1.4 - Scripts

A GHI node acts on and updates its state in regular loops, similar to a game engine. As such, a GHI
node's state may include scripts, said scripts being [agnostic scripts](https://github.com/Telos-Project/OmniQuery?tab=readme-ov-file#21136---agnostic-scripts),
to execute each loop.

#### 2.1.5 - Streams

If any channel is capable of streaming data, it may specify a URL that a remote device, bearing the
necessary credential headers if applicable, may use to access said stream.

#### 2.1.6 - Networking

The state of a GHI node may include connection configurations for both internet and database
access. With whatever means are made available to it, a GHI node will attempt to establish internet
connection.

#### 2.1.7 - Dynamic Casting

Dynamic casting is a mechanism by which a server advertises its reachability through a dynamically
created reverse tunnel. At regular intervals, the server publishes a record to a shared registry.
Each record contains a persistent device ID, a temporary tunnel URL, and a creation timestamp.
Clients read from this registry and use the tunnel URL to communicate directly with the server.

GHI nodes use [Orca](https://github.com/Telos-Project/Orca) logs for dynamic casting, and Orca
objects used for this purpose may be ephemeral.

#### 2.1.8 - Interfaces

Conventions and modules that allow GHI nodes to make satellites out of specific classes of devices
are referred to as GHI interfaces.

### 2.2 - Format

The GHI format is an [APInt](https://github.com/Telos-Project/APInt) format, with all utilities
relevant to GHI having the tag "ghi".

All GHI utilities must therefore use the tags property protocol, and may optionally use the ID
property protocol.

#### 2.2.1 - Channels

A utility representing a GHI channel shall have the tag "ghi-channel", and shall have the property
field "channel", containing an object. The channel object shall have the fields "type", containing
a string specifying the type of channel, "input", containing the input to pass through the channel
on the next loop, "output", containing the data read from the channel on the previous loop.

Also, the channel object may optionally have the fields "input-stream", containing a string URL to
stream data to, "output-stream", containing a string URL to stream data from, and optionally, if
not possessing either of those, "stream", containing a string URL to stream data to and from.

Channels may use the links property protocol to to establish unidirectional links respresenting
satellite relationships, from parent to child.

##### 2.2.1.1 - System Channel

GHI channels with the type "system" represent the system running the GHI node.

The input field for a system channel shall be an array of strings containing terminal commands for
the system to execute. Upon execution, said commands shall be executed in order, they shall be
cleared from the input array, and their outputs shall be written in order as a string array to the
output field of the channel, with any previous output being cleared in the process.

##### 2.2.1.2 - GPIO Channel

GHI channels with the type "gpio" represent a GPIO interface of the device running the GHI node.

A GPIO channel shall have the property "pins", containing a number specifying how many pins the
GPIO interface has.

The input field for a GPIO channel shall be an object where each key is a number specifying the
numerical ID of a given pin. Each such field may contain true, which turns the pin on, false, which
turns the pin off, or may be a number ranging from zero to one, inclusive, to send analog output.
The output field, derived by reading the states of the pins, is formatted the same way.

##### 2.2.1.3 - USB Channel

GHI channels with the type "usb" represent USB devices connected to the device running the GHI
node.

A USB channel shall have the properties "bus", "deviceAddress", "vendorId", "productId", "vendor",
"product", and "serial", containing infomation specifying the corresponding properties for the
connected device.

The input field for a USB channel shall be a string, or an array of numbers or 8 bit hex strings,
to send to the connected device, after which it will be cleared. The output field, derived by
reading the most recent incoming data from the device, is formatted the same way.

##### 2.2.1.4 - Wi-Fi Channel

GHI channels with the type "wifi" represent Wi-Fi access points within range of the device running
the GHI node.

A Bluetooth channel shall have the property "SSID", containing a string specifying the SSID of the
access point.

The input field for a Wi-Fi channel is a boolean which, if true, indicates that the device running
the GHI node is, or is to be, connected to the access point, and if false, indicates that the
device running the GHI node is, or is to be, disconnected from the access point.

##### 2.2.1.5 - Bluetooth Channel

GHI channels with the type "bluetooth" represent Bluetooth devices within range of the device
running the GHI node.

A Bluetooth channel shall have the properties "mac" and "name", containing strings specifying the
corresponding properties for the connected device.

The input field for a Bluetooth channel shall be a string, or an array of numbers or 8 bit hex
strings, to send to the connected device, after which it will be cleared. The output field, derived
by reading the most recent incoming data from the device, is formatted the same way.

#### 2.2.2 - Scripts

A utility representing a GHI script shall have the code of the script as its content, shall have
the tag "ghi-script", and shall have the property field "language", containing a string specifying
the language of the script.

#### 2.2.3 - Persistence

A utility with the tag "ghi-persist" shall persist in the state of a GHI node between system
resets.

#### 2.2.4 - Telos Origin

If its server is running on [Telos Origin](https://github.com/Telos-Project/Telos-Origin), a GHI
node's state may integrate with the APInt of the Telos Origin instance.

As such, any utility with the primary type "telos-module" in such a GHI node's state shall have its
content dynamically integrated into the [bus net](https://github.com/Telos-Project/Bus-Net) of the
Telos Origin instance on which it is running.

#### 2.2.5 - Settings

##### 2.2.5.1 - Connections

A utility representing an internet connection point shall have the tag "ghi-connection", and shall
have the property fields "name", containing a string specifying the name of the access point, and
"password", containing a string specifying the password of the access point.

A utility representing an Orca log location for dynamic casting shall have the tag "ghi-log", and
its content shall be an [OQL](https://github.com/Telos-Project/OmniQuery) selector specifying the
location of said log.

##### 2.2.5.2 - Credentials

A utility representing an access token for the node shall have the tag "ghi-token", and its content
shall be said token.

#### 2.2.6 - Usage

GHI can be set to execute at boot on any Linux system with Node.js installed by running the
following command:

    sudo env "PATH=$PATH" npx telos-origin telos-ghi -e ghi-enable -pool YOUR_OQL_SELECTOR

Where YOUR_OQL_SELECTOR is replaced by an OQL selector for the database location you want the
dynamic casting to be logged to.

For example, an SQL table's selector would look like this:

    (at (access "DB_CONNECTION_STRING") "TABLE_NAME")

And a Mongo collection's selector would look like this:

    (at (access "DB_CONNECTION_STRING") "DATABASE_NAME" "COLLECTION_NAME")

Both of which are best escaped using single quotes.
import { mat4 } from 'neuroglancer/util/geom';

export function getMat4(a: Float32Array): mat4 {
    return mat4.fromValues(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11], a[12], a[13], a[14], a[15]);
}

export function addButtonElement(message: any, key: any, icon: any) {
    let buttonElement = document.createElement("div");
    buttonElement.classList.add("vr-sample-button");
    buttonElement.style.color = "#FFF";
    buttonElement.style.fontWeight = "bold";
    buttonElement.style.backgroundColor = "#888";
    buttonElement.style.borderRadius = "5px";
    buttonElement.style.border = "3px solid #555";
    buttonElement.style.position = "relative";
    buttonElement.style.display = "inline-block";
    buttonElement.style.margin = "0.5em";
    buttonElement.style.padding = "0.75em";
    buttonElement.style.cursor = "pointer";
    buttonElement.align = "center";

    if (icon) {
        buttonElement.innerHTML = "<img src='" + icon + "'/><br/>" + message;
    } else {
        buttonElement.innerHTML = message;
    }

    if (key) {
        var keyElement = document.createElement("span");
        keyElement.classList.add("vr-sample-button-accelerator");
        keyElement.style.fontSize = "0.75em";
        keyElement.style.fontStyle = "italic";
        keyElement.innerHTML = " (" + key + ")";

        buttonElement.appendChild(keyElement);
    }

    getButtonContainer().appendChild(buttonElement);

    return buttonElement;
}

export function getButtonContainer() {
    let buttonContainer = document.getElementById("vr-sample-button-container");
    if (!buttonContainer) {
        buttonContainer = document.createElement("div");
        buttonContainer.id = "vr-sample-button-container";
        buttonContainer.style.fontFamily = "sans-serif";
        buttonContainer.style.position = "absolute";
        buttonContainer.style.zIndex = "999";
        buttonContainer.style.left = "0";
        buttonContainer.style.bottom = "0";
        buttonContainer.style.right = "0";
        buttonContainer.style.margin = "0";
        buttonContainer.style.padding = "0";
        //buttonContainer.align("right");
        document.body.appendChild(buttonContainer);
    }
    return buttonContainer;
}

export function addButton(message: any, key: any, icon: any, callback: any) {
    var keyListener = null;
    if (key) {
        var keyCode = key.charCodeAt(0);
        keyListener = function (event: any) {
            if (event.keyCode === keyCode) {
                callback(event);
            }
        };
        document.addEventListener("keydown", keyListener, false);
    }
    var element = addButtonElement(message, key, icon);
    element.addEventListener("click", function (event) {
        callback(event);
        event.preventDefault();
    }, false);

    return {
        element: element,
        keyListener: keyListener
    };
}

export function addError(message: any, timeout: any) {
    var element = addMessageElement("<b>ERROR:</b> " + message, "#D33");

    if (timeout) {
        makeToast(element, timeout);
    }

    return element;
}


export function addInfo(message: any, timeout: any) {
    var element = addMessageElement(message, "#22A");

    if (timeout) {
        makeToast(element, timeout);
    }

    return element;
}

// Makes the given element fade out and remove itself from the DOM after the
// given timeout.
export function makeToast(element: any, timeout: any) {
    element.style.transition = "opacity 0.5s ease-in-out";
    element.style.opacity = "1";
    setTimeout(function () {
        element.style.opacity = "0";
        setTimeout(function () {
            if (element.parentElement)
                element.parentElement.removeChild(element);
        }, 500);
    }, timeout);
}

export function addMessageElement(message: any, backgroundColor: any) {
    var messageElement = document.createElement("div");
    messageElement.classList.add("vr-sample-message");
    messageElement.style.color = "#FFF";
    messageElement.style.backgroundColor = backgroundColor;
    messageElement.style.borderRadius = "3px";
    messageElement.style.position = "relative";
    messageElement.style.display = "inline-block";
    messageElement.style.margin = "0.5em";
    messageElement.style.padding = "0.75em";

    messageElement.innerHTML = message;

    getMessageContainer().appendChild(messageElement);

    return messageElement;
}

function getMessageContainer() {
    var messageContainer = document.getElementById("vr-sample-message-container");
    if (!messageContainer) {
        messageContainer = document.createElement("div");
        messageContainer.id = "vr-sample-message-container";
        messageContainer.style.fontFamily = "sans-serif";
        messageContainer.style.position = "absolute";
        messageContainer.style.zIndex = "999";
        messageContainer.style.left = "0";
        messageContainer.style.top = "0";
        messageContainer.style.right = "0";
        messageContainer.style.margin = "0";
        messageContainer.style.padding = "0";
        //messageContainer.align = "center";
        document.body.appendChild(messageContainer);
    }
    return messageContainer;
}

export function removeButton(button: any) {
    if (!button)
        return;
    if (button.element.parentElement)
        button.element.parentElement.removeChild(button.element);
    if (button.keyListener)
        document.removeEventListener("keydown", button.keyListener, false);
}

